import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { EVENT, MEMBER, requireMember, parseState, publicRoom, publicMembers, jsonError } from '$lib/server/room.js';
import { thiefView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Odoo datetime string (UTC, second resolution). */
function odooNow() {
	return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Consolidated room poll: events since cursor (private ones filtered to me),
 * members + presence, room status, and the per-session game view when the
 * state version advanced past the client's `gv`.
 */
export async function GET({ params, url, cookies }) {
	try {
		const { uid, room, member, members } = await requireMember(cookies, params.id);
		const since = Number(url.searchParams.get('since')) || 0;
		const gv = Number(url.searchParams.get('gv')) || 0;

		// presence heartbeat — write at most every ~6s, not every poll
		const last = member.x_studio_last_seen
			? new Date(member.x_studio_last_seen.replace(' ', 'T') + 'Z').getTime()
			: 0;
		if (Date.now() - last > 6000) {
			await adminExecute(MEMBER, 'write', [[member.id], { x_studio_last_seen: odooNow() }]);
			member.x_studio_last_seen = odooNow();
		}

		// events: public ones + those privately targeted at me (WebRTC signals)
		const events = await adminExecute(EVENT, 'search_read', [
			[
				['x_studio_room_id', '=', Number(params.id)],
				['id', '>', since],
				'|', ['x_studio_target_uid', '=', false], ['x_studio_target_uid', '=', uid]
			],
			['x_studio_type', 'x_studio_payload', 'x_studio_sender_uid']
		], { order: 'id asc', limit: 200 });

		const out = {
			ok: true,
			cursor: events.length ? events[events.length - 1].id : since,
			events: events.map((e) => ({
				id: e.id,
				type: e.x_studio_type,
				senderUid: e.x_studio_sender_uid,
				payload: safeParse(e.x_studio_payload)
			})),
			room: publicRoom(room),
			members: publicMembers(members)
		};

		const state = parseState(room);
		if (state && state.v > gv) {
			out.state = {
				v: state.v,
				voice: state.voice || [],
				game: viewOf(state.game, uid)
			};
		}
		return json(out);
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

function safeParse(s) {
	try {
		return JSON.parse(s || '{}');
	} catch {
		return {};
	}
}

/** Per-session game view — thief-finder is filtered, others have no secrets. */
function viewOf(game, uid) {
	if (!game) return null;
	if (game.type === 'thief_finder') return thiefView(game, uid);
	return game;
}

import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { EVENT, MEMBER, requireMember, parseState, publicRoom, publicMembers, writeState, jsonError } from '$lib/server/room.js';
import { resolveClaims, stateView } from '$lib/server/gamelogic.js';

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

		// presence heartbeat — write at most every ~6s, not every poll. It needs
		// last_seen from the member read above, so it can't join that wave, but it
		// is independent of the events query and rides along with it.
		const last = member.x_studio_last_seen
			? new Date(member.x_studio_last_seen.replace(' ', 'T') + 'Z').getTime()
			: 0;
		const needHeartbeat = Date.now() - last > 6000;

		// events: public ones + those privately targeted at me (WebRTC signals)
		const [events] = await Promise.all([
			adminExecute(EVENT, 'search_read', [
				[
					['x_studio_room_id', '=', Number(params.id)],
					['id', '>', since],
					'|', ['x_studio_target_uid', '=', false], ['x_studio_target_uid', '=', uid]
				],
				['x_studio_type', 'x_studio_payload', 'x_studio_sender_uid']
			], { order: 'id asc', limit: 200 }),
			// awaited, never fire-and-forget: Amplify freezes the container once the
			// response buffers, and a dropped heartbeat feeds sweepAbandonedRooms
			needHeartbeat
				? adminExecute(MEMBER, 'write', [[member.id], { x_studio_last_seen: odooNow() }])
				: Promise.resolve()
		]);
		if (needHeartbeat) member.x_studio_last_seen = odooNow();

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
		// Self-heal: rebuild claims from the pick log so a lost blob write recovers
		// and the picking→guessing flip still fires if the final picks raced.
		if (state?.game?.type === 'thief_finder' && state.game.phase === 'picking') {
			const picks = await adminExecute(EVENT, 'search_read', [
				[['x_studio_room_id', '=', Number(params.id)], ['x_studio_type', '=', 'pick']],
				['x_studio_sender_uid', 'x_studio_payload']
			], { order: 'id asc' });
			const draw = state.game.draw;
			const rows = picks.filter((r) => {
				try { return JSON.parse(r.x_studio_payload || '{}').draw === draw; } catch { return false; }
			});
			if (resolveClaims(state.game, rows)) await writeState(params.id, state);
		}
		if (state && state.v > gv) out.state = stateView(state, uid);
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

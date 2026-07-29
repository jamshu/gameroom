import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { EVENT, MEMBER, requireMemberCached, parseState, publicRoom, publicMembers, pruneStaleVoice, writeState, jsonError } from '$lib/server/room.js';
import { resolveClaims, filterPickRows, stateView } from '$lib/server/gamelogic.js';
import { isContendedPhase } from '$lib/games.js';

export const prerender = false;

/** Odoo datetime string (UTC, second resolution). */
function odooNow() {
	return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * How stale `last_seen` must be before a poll rewrites it. Sized against
 * PRESENCE_WINDOW_MS (90s in room.js): comfortably under it, so a client polling
 * on the slow push-connected cadence still refreshes in time, but far enough
 * above the old 6s that a member write no longer rides nearly every poll.
 * It also has to stay well under ABANDON_MIN (10 min) or sweepAbandonedRooms
 * would start deleting rooms that are very much alive.
 */
const HEARTBEAT_AFTER_MS = 45000;

/**
 * Consolidated room poll: events since cursor (private ones filtered to me),
 * members + presence, room status, and the per-session game view when the
 * state version advanced past the client's `gv`.
 */
export async function GET({ params, url, cookies }) {
	try {
		const { uid, room, member, members } = await requireMemberCached(cookies, params.id);
		const since = Number(url.searchParams.get('since')) || 0;
		const gv = Number(url.searchParams.get('gv')) || 0;

		// presence heartbeat — throttled, not once per poll. It needs last_seen from
		// the member read above, so it can't join that wave, but it is independent
		// of the events query and rides along with it.
		const last = member.x_studio_last_seen
			? new Date(member.x_studio_last_seen.replace(' ', 'T') + 'Z').getTime()
			: 0;
		const needHeartbeat = Date.now() - last > HEARTBEAT_AFTER_MS;

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
		// Prune voice-roster ghosts (offline members). writeState bumps the version
		// and pushes the cleaned roster to everyone; the `state.v > gv` gate below
		// then also serves it. Only writes when something is actually stale, so a
		// healthy all-online roster costs nothing.
		// ponytail: if two clients prune the same ghost inside the 750ms cache window
		// they both write — harmless, they filter to the same result.
		if (state && pruneStaleVoice(state, members)) {
			await writeState(params.id, state, {});
		}
		// Self-heal: rebuild claims from the pick log so a lost blob write recovers
		// and the picking→guessing flip still fires if the final picks raced.
		if (state?.game?.type === 'thief_finder' && state.game.phase === 'picking') {
			const picks = await adminExecute(EVENT, 'search_read', [
				[['x_studio_room_id', '=', Number(params.id)], ['x_studio_type', '=', 'pick']],
				['x_studio_sender_uid', 'x_studio_payload']
			], { order: 'id asc' });
			const rows = filterPickRows(picks, state.game);
			// guardVersion: `state` was parsed off a room row served from the 750ms
			// snapshot cache, and writeState's invalidate only reaches THIS Lambda
			// container — another one's pick can already have moved the version on.
			// Without the guard this read endpoint writes a version it has already
			// been overtaken by, which is the same wedge the pick route guards
			// against, arriving from the one path meant to HEAL it. The extra read
			// rides only the rare poll where resolveClaims actually found a gap.
			if (resolveClaims(state.game, rows)) {
				await writeState(params.id, state, {}, { guardVersion: true });
			}
		}
		// `v > gv` is what keeps the 60s safety poll cheap — normally there is
		// nothing to say. The exception is the contended phase: two simultaneous
		// picks can both land on the SAME v with different claim maps, and a client
		// holding the emptier one sits at gv == v, so a strict `>` would never send
		// it anything again. Equal versions go out there and mergeState decides.
		const contended = isContendedPhase(state?.game);
		if (state && (state.v > gv || (contended && state.v === gv))) out.state = stateView(state, uid);
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

import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { EVENT, MEMBER, requireMemberCached, parseState, publicRoom, publicMembers, writeState, jsonError, httpError } from '$lib/server/room.js';
import { resolveClaims, filterPickRows, stateView } from '$lib/server/gamelogic.js';
import { isContendedPhase } from '$lib/games.js';
import { isDoRoom } from '$lib/server/doflag.js';
import { doOp, isEvacuated } from '$lib/server/dostub.js';

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
export async function GET({ params, url, cookies, platform }) {
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

		// Events come from the Durable Object once it owns the log — its seq IS the
		// id clients key chat by, and after M2.4 a DO-minted event does not exist in
		// Odoo until the archive alarm drains (and lands there under a DIFFERENT
		// id). Querying Odoo here would return an id the client has never seen for a
		// message it already has.
		//
		// `gap` is the flag this path was missing. Once the object trims its log, a
		// client whose cursor fell below the oldest retained seq gets the newest page
		// and would jump its cursor to the end — silently losing the block in
		// between, with nothing to notice it by. The socket has `resync` for exactly
		// this; additive here, so old bundles and every existing spec mock ignore it.
		const doEvents = isDoRoom(params.id) ? await doOp(params.id, { op: 'events', uid, since }) : null;
		if (doEvents && !doEvents.ok && !isEvacuated(doEvents)) {
			throw httpError(503, 'The room is busy — try again', 'do_unreachable');
		}
		// `owns`, not merely "the object answered". Before the ownership transfer its
		// log holds only the pushes delivered since it woke, while Odoo holds the
		// room's whole history — serving from the object there would show a client
		// opening an established room an empty one, which is a regression against
		// M2.3 rather than a new behaviour. And it is safe by construction: `append`
		// is an owning op, so while this is false no DO-minted id exists to miss.
		const fromDo = doEvents?.ok && doEvents.owns ? doEvents : null;

		// events: public ones + those privately targeted at me (WebRTC signals)
		const [events] = await Promise.all([
			fromDo ? [] : adminExecute(EVENT, 'search_read', [
				[
					['x_studio_room_id', '=', Number(params.id)],
					['id', '>', since],
					'|', ['x_studio_target_uid', '=', false], ['x_studio_target_uid', '=', uid]
				],
				['x_studio_type', 'x_studio_payload', 'x_studio_sender_uid']
			], { order: 'id asc', limit: 200 }),
			// Deferred, never dropped. Under Amplify this had to be awaited because
			// the container froze once the response buffered; Workers' waitUntil
			// keeps the invocation alive instead, so the poll no longer waits on an
			// Odoo write its own response does not depend on (line below already
			// updates the local copy). DROPPING it is not an option — a lost
			// heartbeat makes the room look abandoned and the cron sweep deletes it.
			needHeartbeat
				? (() => {
						const w = adminExecute(MEMBER, 'write', [[member.id], { x_studio_last_seen: odooNow() }]);
						const ctx = platform?.ctx ?? platform?.context;
						if (ctx?.waitUntil) {
							ctx.waitUntil(w.catch((e) => console.error('heartbeat failed:', e?.message)));
							return Promise.resolve();
						}
						return w;
					})()
				: Promise.resolve()
		]);
		if (needHeartbeat) member.x_studio_last_seen = odooNow();

		const out = {
			ok: true,
			cursor: fromDo ? fromDo.cursor : events.length ? events[events.length - 1].id : since,
			// The object already returns the client shape (schema.js toClientEvent),
			// field for field — `id`, `type`, `senderUid`, `payload` — so the envelope
			// is byte-identical whichever store answered.
			events: fromDo
				? fromDo.events
				: events.map((e) => ({
						id: e.id,
						type: e.x_studio_type,
						senderUid: e.x_studio_sender_uid,
						payload: safeParse(e.x_studio_payload)
					})),
			room: publicRoom(room),
			// Live socket presence, unioned with last_seen — see roomview.isOnline.
			// Without the object's view this envelope would disagree with the roster
			// frames the very same room receives on the socket, and a presence dot
			// that flickers when a client changes transport is close to
			// unattributable.
			members: publicMembers(members, fromDo ? new Set(fromDo.liveUids) : null)
		};
		// Additive: `since = 0` is a fresh client and needs no flag, so this only
		// ever appears on a cursor that genuinely fell off the retained log.
		if (fromDo?.gap) out.gap = true;

		const state = parseState(room);
		// pruneStaleVoice is GONE as of M2.6, and this endpoint no longer writes.
		//
		// It inferred voice ghosts from a 90-second staleness window because nothing
		// better existed, and it did so from a READ endpoint — the one thing that
		// would trip the single-writer guard. The object holds the live socket set,
		// so RoomDO.onSocketGone drops the uid from `state.voice` and ends the call
		// the moment a player actually goes: exact, and in milliseconds rather than
		// a minute and a half.
		//
		// Self-heal: rebuild claims from the pick log so a lost blob write recovers
		// and the picking→guessing flip still fires if the final picks raced.
		//
		// Also skipped for DO rooms. It is a repair for a race that cannot happen
		// there: the object appends the pick, re-resolves the claim map from its own
		// log and writes state as ONE synchronous step (RoomDO.thiefPick), so there
		// is no window between them for a second pick to land in. Keeping it would
		// re-read the whole pick log on every poll of a picking room to repair
		// nothing.
		if (!isDoRoom(params.id) && state?.game?.type === 'thief_finder' && state.game.phase === 'picking') {
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

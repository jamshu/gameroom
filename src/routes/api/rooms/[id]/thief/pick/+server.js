import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError, EVENT } from '$lib/server/room.js';
import { adminExecute } from '$lib/server/odoo.js';
import { resolveClaims, filterPickRows, stateView } from '$lib/server/gamelogic.js';
import { isDoRoom } from '$lib/server/doflag.js';
import { doOp, isEvacuated } from '$lib/server/dostub.js';

export const prerender = false;

/** A player opens an envelope. First-come wins; the log (event id) is the arbiter. */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		// Read once: the body is a stream, and the evacuated fallback below would
		// otherwise reach the Odoo path with it already consumed.
		const { envelope } = await request.json();

		// The one route in the app that several players hit at the same instant, so
		// it is the one that gets the object's atomicity rather than the seam.
		// writeState's dispatch would still be three separate ops here — append,
		// re-read the pick log, write — with other picks free to interleave between
		// them, which is the exact race guardVersion could only order after the fact.
		// RoomDO.thiefPick does all three inside the object, where nothing can.
		if (isDoRoom(params.id)) {
			const res = await doOp(params.id, { op: 'thiefPick', uid, envelope });
			if (res?.ok) return json({ ok: true, state: stateView(res.state, uid) });
			if (!isEvacuated(res)) {
				// The object's rejections carry the same status/code the Odoo path threw,
				// so the client's `taken` handling is unchanged.
				throw httpError(res?.status || 503, res?.error || 'The room is busy — try again', res?.code);
			}
			// evacuated — fall through to the Odoo path below, which is now correct again
		}

		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'thief_finder') throw httpError(409, 'No thief-finder game in progress');
		if (game.phase !== 'picking') throw httpError(409, 'Not in the picking phase');
		if (!game.players.includes(uid)) throw httpError(403, 'You are not a player');

		const k = Number(envelope);
		if (!Number.isInteger(k) || k < 0 || k >= game.players.length) throw httpError(400, 'No such envelope');
		// best-effort fast reject; resolveClaims below is the real arbiter
		if (game.claims?.[k] != null && game.claims[k] !== uid) throw httpError(409, 'Envelope already taken', 'taken');

		await appendEvent(params.id, 'pick', { epoch: game.epoch, draw: game.draw, envelope: k }, uid);
		resolveClaims(game, filterPickRows(await pickRows(params.id), game));
		// guardVersion: this is the ONE route several players hit at the same instant
		// (that is the whole game), and `state.v` was read three Odoo round trips ago
		// — before appendEvent and the pick-log read above. Without the guard, two
		// simultaneous taps both publish the same v with different claim maps, and
		// whichever client latched the emptier one can never be corrected. The
		// re-read costs one call per pick; see writeState for the full reasoning.
		await writeState(params.id, state, {}, { guardVersion: true });
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

/** The room's whole pick log, oldest first — id order is the first-come order.
 *  Scoped to this game's current draw by filterPickRows at the call site. */
async function pickRows(id) {
	return adminExecute(EVENT, 'search_read', [
		[['x_studio_room_id', '=', Number(id)], ['x_studio_type', '=', 'pick']],
		['x_studio_sender_uid', 'x_studio_payload']
	], { order: 'id asc' });
}

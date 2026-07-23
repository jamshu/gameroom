import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError, EVENT } from '$lib/server/room.js';
import { adminExecute } from '$lib/server/odoo.js';
import { resolveClaims, filterPickRows, stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** A player opens an envelope. First-come wins; the log (event id) is the arbiter. */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'thief_finder') throw httpError(409, 'No thief-finder game in progress');
		if (game.phase !== 'picking') throw httpError(409, 'Not in the picking phase');
		if (!game.players.includes(uid)) throw httpError(403, 'You are not a player');

		const { envelope } = await request.json();
		const k = Number(envelope);
		if (!Number.isInteger(k) || k < 0 || k >= game.players.length) throw httpError(400, 'No such envelope');
		// best-effort fast reject; resolveClaims below is the real arbiter
		if (game.claims?.[k] != null && game.claims[k] !== uid) throw httpError(409, 'Envelope already taken', 'taken');

		await appendEvent(params.id, 'pick', { epoch: game.epoch, draw: game.draw, envelope: k }, uid);
		resolveClaims(game, filterPickRows(await pickRows(params.id), game));
		await writeState(params.id, state);
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

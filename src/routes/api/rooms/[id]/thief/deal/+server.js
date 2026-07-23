import { json } from '@sveltejs/kit';
import { requireHost, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { thiefDeal, stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Host lays the envelopes for the next draw; players open them to get their cards. */
export async function POST({ params, cookies }) {
	try {
		const { uid, room } = await requireHost(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'thief_finder') throw httpError(409, 'No thief-finder game in progress');

		thiefDeal(game);
		await writeState(params.id, state);
		await appendEvent(params.id, 'system', {
			kind: 'draw-dealt',
			draw: game.draw,
			envelopeCount: game.envelopes.length
		}, uid);
		// echo the caller's filtered view so they don't pay an extra poll for it
		return json({ ok: true, draw: game.draw, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

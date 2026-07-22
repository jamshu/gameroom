import { json } from '@sveltejs/kit';
import { requireHost, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { thiefDeal } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Host starts the next draw: roles shuffled server-side, police revealed publicly. */
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
			policeUid: game.policeUid
		}, uid);
		return json({ ok: true, draw: game.draw });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

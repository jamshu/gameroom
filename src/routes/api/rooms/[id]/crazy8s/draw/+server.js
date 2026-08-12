import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';
import { drawCard } from '$lib/shared/crazy8s.js';

export const prerender = false;

/** Draw one card and pass the turn — the "I can't play" move. See crazy8s.js. */
export async function POST({ params, cookies }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'crazy8s') throw httpError(409, 'No Crazy Eights game in progress');

		drawCard(game, uid); // throws httpError if it isn't your turn / you're a spectator

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind: 'draw', uid, v: state.v }, uid);
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

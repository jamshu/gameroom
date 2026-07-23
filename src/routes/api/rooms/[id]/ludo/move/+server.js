import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, finishRoom, jsonError, httpError } from '$lib/server/room.js';
import { ludoMove, ludoScores, stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** The current player moves a token by the pending dice. */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'ludo') throw httpError(409, 'No ludo game in progress');

		const { token } = await request.json();
		ludoMove(game, uid, token);
		const kind = game.lastEvent?.kind || 'move';

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind, uid, token: Number(token) }, uid);

		if (game.result) {
			await finishRoom(params.id, members, ludoScores(game));
			await appendEvent(params.id, 'system', { kind: 'game-over', winner: game.result }, uid);
		}
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

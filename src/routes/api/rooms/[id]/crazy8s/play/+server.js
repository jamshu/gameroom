import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, finishRoom, jsonError, httpError } from '$lib/server/room.js';
import { stateView, crazy8sScores, winnerUids } from '$lib/server/gamelogic.js';
import { playCard } from '$lib/shared/crazy8s.js';

export const prerender = false;

/**
 * Play one card. Turn-based single-writer — only the player at `turnIdx` mutates —
 * so a plain writeState is enough, the same shape chess/move uses (no DO race op).
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'crazy8s') throw httpError(409, 'No Crazy Eights game in progress');

		const { card, suit } = await request.json();
		const res = playCard(game, uid, card, suit); // throws httpError on an illegal play

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind: 'play', uid, card, v: state.v }, uid);

		if (res.won) {
			await finishRoom(params.id, members, crazy8sScores(game), room, { state, winners: winnerUids(game) });
			await appendEvent(
				params.id,
				'system',
				{ kind: 'game-over', result: game.result, endReason: 'emptied-hand', winnerUid: game.result },
				uid
			);
		}
		return json({ ok: true, won: res.won, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

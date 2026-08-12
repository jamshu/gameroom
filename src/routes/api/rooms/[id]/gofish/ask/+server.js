import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, finishRoom, jsonError, httpError } from '$lib/server/room.js';
import { stateView, gofishScores, winnerUids } from '$lib/server/gamelogic.js';
import { ask } from '$lib/shared/gofish.js';

export const prerender = false;

/** Ask a rival for a rank. Turn-based single-writer — plain writeState, like chess. */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'gofish') throw httpError(409, 'No Go Fish game in progress');

		const { target, rank } = await request.json();
		const res = ask(game, uid, target, rank); // throws httpError on an illegal ask

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind: 'ask', uid, ...res.result, v: state.v }, uid);

		if (game.result === 'done') {
			await finishRoom(params.id, members, gofishScores(game), room, { state, winners: winnerUids(game) });
			await appendEvent(
				params.id,
				'system',
				{ kind: 'game-over', result: 'done', endReason: 'books', winnerUid: winnerUids(game)[0] ?? null },
				uid
			);
		}
		return json({ ok: true, keepTurn: res.keepTurn, ask: res.result, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

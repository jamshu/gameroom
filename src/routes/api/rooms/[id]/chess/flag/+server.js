import { json } from '@sveltejs/kit';
import {
	requireMember,
	parseState,
	writeState,
	appendEvent,
	finishRoom,
	jsonError,
	httpError
} from '$lib/server/room.js';
import { stateView, chessClockNow, chessClockCommit, chessScores } from '$lib/server/gamelogic.js';

export const prerender = false;

/**
 * Claim a win on time.
 *
 * Clients only ever *suggest* this — the server recomputes from its own clock,
 * so a client with a fast clock or a tampered timer can't steal a game. Callers
 * race deliberately (the opponent claims first, the flagged player and then
 * spectators act as fallbacks so a closed tab can't hang the room forever), so
 * the no-op path must be cheap: it writes nothing at all.
 */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'chess') throw httpError(409, 'No chess game in progress');

		// already decided, or the clock hasn't actually run out — 0 writes
		const live = chessClockNow(game);
		if (game.result || !live?.ticking || live[live.ticking] > 0) {
			return json({ ok: true, flagged: false, state: stateView(state, uid) });
		}

		chessClockCommit(game);
		game.result = live.ticking === 'w' ? 'b' : 'w';
		game.clock.turnStartedAt = null;

		await writeState(params.id, state);
		await finishRoom(params.id, members, chessScores(game));
		await appendEvent(
			params.id,
			'system',
			{ kind: 'game-over', result: game.result, by: 'timeout' },
			uid
		);
		return json({ ok: true, flagged: true, result: game.result, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

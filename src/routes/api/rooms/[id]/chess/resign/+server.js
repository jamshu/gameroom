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
import { stateView, chessScores } from '$lib/server/gamelogic.js';

export const prerender = false;

/**
 * Resign the game. The caller loses; their opponent is credited the win.
 *
 * Terminal and one-directional — mirrors `chess/flag` but the trigger is an
 * explicit forfeit rather than a clock read. Spectators can't resign, and a
 * finished game writes nothing.
 */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'chess') throw httpError(409, 'No chess game in progress');
		if (game.result) throw httpError(409, 'Game is finished');

		const myColor = game.players.w === uid ? 'w' : game.players.b === uid ? 'b' : null;
		if (!myColor) throw httpError(403, 'You are a spectator');

		game.result = myColor === 'w' ? 'b' : 'w';
		game.endReason = 'resign';
		if (game.clock) game.clock.turnStartedAt = null; // freeze the clock on a finished game
		delete game.drawOffer;

		await writeState(params.id, state);
		await finishRoom(params.id, members, chessScores(game));
		await appendEvent(
			params.id,
			'system',
			{ kind: 'game-over', result: game.result, by: 'resign', uid },
			uid
		);
		return json({ ok: true, result: game.result, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

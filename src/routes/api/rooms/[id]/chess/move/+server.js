import { json } from '@sveltejs/kit';
import { Chess } from 'chess.js';
import { requireMember, parseState, writeState, appendEvent, finishRoom, jsonError, httpError } from '$lib/server/room.js';
import { stateView, chessClockCommit, chessScores, winnerUids } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Server-authoritative chess move — legality + turn enforced with chess.js. */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'chess') throw httpError(409, 'No chess game in progress');
		if (game.result) throw httpError(409, 'Game is finished');

		const chess = new Chess(game.fen);
		const myColor = game.players.w === uid ? 'w' : game.players.b === uid ? 'b' : null;
		if (!myColor) throw httpError(403, 'You are a spectator');
		if (chess.turn() !== myColor) throw httpError(409, 'Not your turn');

		const { from, to, promotion } = await request.json();

		// Charge the mover for their thinking time BEFORE applying the move — if
		// that runs them out, the move doesn't count and they lost on time.
		if (chessClockCommit(game)) {
			game.result = myColor === 'w' ? 'b' : 'w';
			game.endReason = 'timeout';
			game.clock.turnStartedAt = null;
			await writeState(params.id, state);
			await finishRoom(params.id, members, chessScores(game), room, { state, winners: winnerUids(game) });
			await appendEvent(
				params.id,
				'system',
				{
					kind: 'game-over',
					result: game.result,
					by: 'timeout',
					endReason: 'timeout',
					winnerUid: game.players[game.result] ?? null
				},
				uid
			);
			return json({ ok: true, result: game.result, flagged: true, state: stateView(state, uid) });
		}

		let move;
		try {
			move = chess.move({ from, to, promotion: promotion || 'q' });
		} catch {
			throw httpError(400, 'Illegal move');
		}

		game.fen = chess.fen();
		game.moves.push(move.san);
		delete game.drawOffer; // making a move declines any outstanding draw offer
		// Specific-first: chess.js `isDraw()` already returns true for a stalemate,
		// a threefold repetition and insufficient material, so testing it before
		// them would collapse every draw into the fifty-move label. It stays last as
		// the catch-all.
		if (chess.isCheckmate()) {
			game.result = myColor;
			game.endReason = 'checkmate';
		} else if (chess.isStalemate()) {
			game.result = 'draw';
			game.endReason = 'stalemate';
		} else if (chess.isThreefoldRepetition()) {
			game.result = 'draw';
			game.endReason = 'repetition';
		} else if (chess.isInsufficientMaterial()) {
			game.result = 'draw';
			game.endReason = 'insufficient';
		} else if (chess.isDraw()) {
			game.result = 'draw';
			game.endReason = 'fifty-move';
		}
		// freeze the clock on a finished game, or every client keeps ticking it
		// down and eventually fires a bogus flag claim
		if (game.result && game.clock) game.clock.turnStartedAt = null;

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { san: move.san, fen: game.fen, v: state.v }, uid);

		if (game.result) {
			await finishRoom(params.id, members, chessScores(game), room, { state, winners: winnerUids(game) });
			await appendEvent(
				params.id,
				'system',
				{
					kind: 'game-over',
					result: game.result,
					endReason: game.endReason,
					// Carried on the event rather than looked up client-side. The banner
					// fires the instant the event lands, which can be before the state
					// holding `game.players` has arrived — resolving the winner from the
					// store would then name nobody.
					winnerUid: game.players[game.result] ?? null
				},
				uid
			);
		}
		return json({ ok: true, san: move.san, fen: game.fen, result: game.result, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

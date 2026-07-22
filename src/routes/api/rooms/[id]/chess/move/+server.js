import { json } from '@sveltejs/kit';
import { Chess } from 'chess.js';
import { requireMember, parseState, writeState, appendEvent, finishRoom, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

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
		let move;
		try {
			move = chess.move({ from, to, promotion: promotion || 'q' });
		} catch {
			throw httpError(400, 'Illegal move');
		}

		game.fen = chess.fen();
		game.moves.push(move.san);
		if (chess.isCheckmate()) game.result = myColor;
		else if (chess.isDraw() || chess.isStalemate()) game.result = 'draw';

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { san: move.san, fen: game.fen, v: state.v }, uid);

		if (game.result) {
			// win 2, draw 1 each (integer scores)
			const scores = {};
			scores[game.players.w] = game.result === 'w' ? 2 : game.result === 'draw' ? 1 : 0;
			scores[game.players.b] = game.result === 'b' ? 2 : game.result === 'draw' ? 1 : 0;
			await finishRoom(params.id, members, scores);
			await appendEvent(params.id, 'system', { kind: 'game-over', result: game.result }, uid);
		}
		return json({ ok: true, san: move.san, fen: game.fen, result: game.result, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

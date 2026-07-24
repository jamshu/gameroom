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
 * Draw handshake: offer / accept / decline.
 *
 * The pending offer lives in game state (`game.drawOffer` = offerer uid) and so
 * rides the normal state push to both players. A move implicitly declines an
 * outstanding offer — that's handled in `chess/move`, not here.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'chess') throw httpError(409, 'No chess game in progress');
		if (game.result) throw httpError(409, 'Game is finished');

		const myColor = game.players.w === uid ? 'w' : game.players.b === uid ? 'b' : null;
		if (!myColor) throw httpError(403, 'You are a spectator');

		const { action } = await request.json();

		if (action === 'offer') {
			if (game.drawOffer) throw httpError(409, 'A draw offer is already pending');
			game.drawOffer = uid;
			await writeState(params.id, state);
			await appendEvent(params.id, 'system', { kind: 'draw-offer', uid }, uid);
			return json({ ok: true, state: stateView(state, uid) });
		}

		if (action === 'decline') {
			if (game.drawOffer && game.drawOffer !== uid) {
				delete game.drawOffer;
				await writeState(params.id, state);
			}
			return json({ ok: true, state: stateView(state, uid) });
		}

		if (action === 'accept') {
			// Re-validate: a pending offer from the OTHER player, game still live.
			// Closes the race where the opponent checkmates on the same tick the
			// accept lands — we must not turn a decided game into a draw.
			if (!game.drawOffer || game.drawOffer === uid) {
				throw httpError(409, 'No draw offer to accept');
			}
			game.result = 'draw';
			game.endReason = 'draw-agreed';
			delete game.drawOffer;
			if (game.clock) game.clock.turnStartedAt = null;

			await writeState(params.id, state);
			await finishRoom(params.id, members, chessScores(game));
			await appendEvent(
				params.id,
				'system',
				{ kind: 'game-over', result: 'draw', by: 'agreement' },
				uid
			);
			return json({ ok: true, result: 'draw', state: stateView(state, uid) });
		}

		throw httpError(400, 'Unknown draw action');
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

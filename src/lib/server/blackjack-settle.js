// Shared by the blackjack hit + stand routes: both can end the round (the dealer
// resolves inside whichever action finishes the last seat), so the "credit the
// winners and announce it" step lives in one place rather than being duplicated
// or cross-imported between two +server.js files.
import { finishRoom, appendEvent } from '$lib/server/room.js';
import { blackjackScores, winnerUids } from '$lib/server/gamelogic.js';

export async function settleBlackjack(roomId, state, members, room, uid) {
	const game = state.game;
	await finishRoom(roomId, members, blackjackScores(game), room, { state, winners: winnerUids(game) });
	await appendEvent(
		roomId,
		'system',
		{ kind: 'game-over', result: 'done', endReason: 'dealer', winnerUid: null },
		uid
	);
}

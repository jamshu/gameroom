// Crazy Eights — the classic shedding game. Match the top card's suit OR rank,
// or play any 8 as a wild and name the next suit. First to empty their hand wins.
//
// Isomorphic (no `$lib`/`$env`): the rules run in the /api route AND in nothing
// else server-side, but the solo bot imports `legalPlays` from here too, so one
// legality rule serves the room, the check script and the bot.
//
// TURN-BASED, SINGLE WRITER: only the player at `turnIdx` ever mutates, so the
// route persists with a plain writeState the way chess does — no race machinery.
import { httpError } from './errors.js';
import { makeDeck, shuffle } from './cards.js';

const HAND_SIZE = 7; // 7 for 2 players is standard; kept flat for 3-6 too — plenty.

export function initCrazy8s(playerUids) {
	if (playerUids.length < 2 || playerUids.length > 6) {
		throw httpError(400, 'Crazy Eights needs 2 to 6 players');
	}
	const deck = shuffle(makeDeck());
	const hands = {};
	for (const uid of playerUids) hands[uid] = deck.splice(0, HAND_SIZE);
	// Turn up the first non-8 as the starting discard — an 8 on top would leave
	// `activeSuit` undefined with nobody having declared it.
	let firstIdx = deck.findIndex((c) => c.r !== 8);
	if (firstIdx < 0) firstIdx = 0; // 45-card deck with five 8s up top: astronomically unlikely, but don't crash
	const [top] = deck.splice(firstIdx, 1);
	return {
		type: 'crazy8s',
		players: [...playerUids],
		turnIdx: 0,
		hands,
		stock: deck,
		discard: [top],
		activeSuit: top.s, // the suit that must be matched (top's own, until an 8 changes it)
		lastEvent: null, // { kind, uid, card?, suit? } — drives client sound/animation
		result: null // winner uid once a hand is emptied
	};
}

/** The top of the discard pile — what the next play must match. */
export const topCard = (game) => game.discard[game.discard.length - 1];

/**
 * Which of `hand`'s cards are legal against `activeSuit` / `topRank`. An 8 is
 * always legal (wild). Pure — the bot and the UI both call it, so a card the UI
 * greys out is exactly one the server would refuse.
 */
export function legalPlays(hand, activeSuit, topRank) {
	return (hand || []).filter((c) => c.r === 8 || c.s === activeSuit || c.r === topRank);
}

function currentUid(game) {
	return game.players[game.turnIdx];
}

function advance(game) {
	game.turnIdx = (game.turnIdx + 1) % game.players.length;
}

/**
 * Play `card` from `uid`'s hand. `chosenSuit` (0..3) is required when the card is
 * an 8 and ignored otherwise. Wins the game by emptying the hand. Mutates `game`.
 */
export function playCard(game, uid, card, chosenSuit) {
	if (game.result) throw httpError(409, 'Game is finished');
	if (uid !== currentUid(game)) throw httpError(409, 'Not your turn');
	const hand = game.hands[uid];
	if (!hand) throw httpError(403, 'You are a spectator');

	const idx = hand.findIndex((c) => c.r === card?.r && c.s === card?.s);
	if (idx < 0) throw httpError(400, 'You do not hold that card');

	const top = topCard(game);
	const isLegal = card.r === 8 || card.s === game.activeSuit || card.r === top.r;
	if (!isLegal) throw httpError(400, 'That card matches neither the suit nor the rank');

	let suit = card.s;
	if (card.r === 8) {
		suit = Number(chosenSuit);
		if (!Number.isInteger(suit) || suit < 0 || suit > 3) {
			throw httpError(400, 'Name a suit for your eight');
		}
	}

	hand.splice(idx, 1);
	game.discard.push(card);
	game.activeSuit = suit;
	game.lastEvent = { kind: 'play', uid, card, suit };

	if (hand.length === 0) {
		game.result = Number(uid);
		return { ok: true, won: true };
	}
	advance(game);
	return { ok: true, won: false };
}

/**
 * Draw one card and pass the turn — the "I can't (or won't) play" move.
 *
 * Deliberately does NOT let you then play the drawn card: one atomic action per
 * request keeps this a single-writer turn like every other card action. When the
 * stock runs dry, the discard (all but its top) is reshuffled back into it; if
 * there is nothing left to reshuffle, the draw is an empty pass.
 */
export function drawCard(game, uid) {
	if (game.result) throw httpError(409, 'Game is finished');
	if (uid !== currentUid(game)) throw httpError(409, 'Not your turn');
	const hand = game.hands[uid];
	if (!hand) throw httpError(403, 'You are a spectator');

	if (game.stock.length === 0) reshuffleDiscard(game);
	let drew = null;
	if (game.stock.length > 0) {
		drew = game.stock.pop();
		hand.push(drew);
	}
	game.lastEvent = { kind: 'draw', uid };
	advance(game);
	return { ok: true, drew };
}

/** Recycle the discard (keeping its face-up top) back into a shuffled stock. */
function reshuffleDiscard(game) {
	if (game.discard.length <= 1) return;
	const top = game.discard.pop();
	game.stock = shuffle(game.discard);
	game.discard = [top];
}

/** One point to the winner; everyone else zero. Shape matches sudokuScores. */
export function crazy8sScores(game) {
	return Object.fromEntries(
		game.players.map((u) => [u, Number(u) === Number(game.result) ? 1 : 0])
	);
}

/**
 * Per-session view. The caller sees their own hand in full; every rival hand is
 * reduced to a count, and the stock to a count — the same hidden-hand shape
 * sudokuView uses for rival grids. A spectator (uid holds no hand) sees only
 * counts, which is correct.
 */
export function crazy8sView(game, uid) {
	const me = String(uid);
	const hands = {};
	for (const [id, h] of Object.entries(game.hands)) {
		hands[id] = id === me ? h : { count: h.length };
	}
	return {
		type: game.type,
		players: game.players,
		turnIdx: game.turnIdx,
		hands,
		stockCount: game.stock.length,
		discardTop: topCard(game),
		activeSuit: game.activeSuit,
		lastEvent: game.lastEvent,
		result: game.result
	};
}

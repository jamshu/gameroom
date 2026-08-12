// Blackjack, no-money variant — beat the dealer's hand without going over 21.
// Each player plays in seat order (hit until they stand or bust), then the dealer
// reveals the hole card and draws to 17. Win/lose/push only; there is no betting
// (deliberate scope cut — add chips later without touching the rules below).
//
// Isomorphic (no `$lib`/`$env`). TURN-BASED, SINGLE WRITER: play runs one seat at
// a time, and the dealer's whole draw resolves inside the one action that ends the
// last seat — so the /api route persists with a plain writeState, like chess.
import { httpError } from './errors.js';
import { makeDeck, shuffle } from './cards.js';

const DEALER_STANDS = 17; // dealer hits on 16 or less, stands on 17+

export function initBlackjack(playerUids) {
	if (playerUids.length < 1 || playerUids.length > 6) {
		throw httpError(400, 'Blackjack needs 1 to 6 players');
	}
	const deck = shuffle(makeDeck());
	const hands = {};
	for (const uid of playerUids) hands[uid] = [deck.pop(), deck.pop()];
	const dealer = [deck.pop(), deck.pop()]; // dealer[1] is the hole card, hidden until reveal
	return {
		type: 'blackjack',
		players: [...playerUids],
		turnIdx: 0, // whose seat is acting
		hands,
		dealer,
		stock: deck,
		standing: Object.fromEntries(playerUids.map((u) => [u, false])),
		busted: Object.fromEntries(playerUids.map((u) => [u, false])),
		phase: 'playing', // playing -> done (dealer resolves in the closing action)
		outcomes: null, // { uid: 'win'|'lose'|'push' } once done
		lastEvent: null,
		result: null // 'done' marker so winnerUids/finishRoom fire
	};
}

/**
 * Best hand total. Aces are 11 until that would bust, then 1. Returns the total
 * and whether it busts — pure, so the UI, the dealer loop and the check agree.
 */
export function handValue(cards) {
	let total = 0;
	let aces = 0;
	for (const c of cards || []) {
		if (c.r === 14) {
			aces++;
			total += 11;
		} else {
			total += Math.min(c.r, 10); // J/Q/K (11-13) are all 10
		}
	}
	while (total > 21 && aces > 0) {
		total -= 10;
		aces--;
	}
	return { total, bust: total > 21 };
}

const currentUid = (game) => game.players[game.turnIdx];

/** Move to the next seat that still has a decision; resolve the dealer if none do. */
function advance(game) {
	for (let i = game.turnIdx + 1; i < game.players.length; i++) {
		const uid = game.players[i];
		if (!game.standing[uid] && !game.busted[uid]) {
			game.turnIdx = i;
			return;
		}
	}
	resolveDealer(game);
}

/**
 * Dealer reveals and draws to 17, then every non-bust player is scored against
 * the dealer's total. Called once, when the last seat finishes.
 */
function resolveDealer(game) {
	while (handValue(game.dealer).total < DEALER_STANDS) game.dealer.push(game.stock.pop());
	const dealer = handValue(game.dealer);
	const outcomes = {};
	for (const uid of game.players) {
		const p = handValue(game.hands[uid]);
		if (p.bust) outcomes[uid] = 'lose';
		else if (dealer.bust || p.total > dealer.total) outcomes[uid] = 'win';
		else if (p.total < dealer.total) outcomes[uid] = 'lose';
		else outcomes[uid] = 'push';
	}
	game.outcomes = outcomes;
	game.phase = 'done';
	game.result = 'done';
	game.lastEvent = { kind: 'dealer', total: dealer.total, bust: dealer.bust };
}

/** Draw a card for the acting player. A bust ends their seat. */
export function hit(game, uid) {
	if (game.result) throw httpError(409, 'The round is over');
	if (uid !== currentUid(game)) throw httpError(409, 'Not your turn');
	if (!game.hands[uid]) throw httpError(403, 'You are a spectator');

	game.hands[uid].push(game.stock.pop());
	game.lastEvent = { kind: 'hit', uid };
	if (handValue(game.hands[uid]).bust) {
		game.busted[uid] = true;
		advance(game);
		return { ok: true, bust: true };
	}
	return { ok: true, bust: false };
}

/** Stand pat — end this seat and pass on (or trigger the dealer). */
export function stand(game, uid) {
	if (game.result) throw httpError(409, 'The round is over');
	if (uid !== currentUid(game)) throw httpError(409, 'Not your turn');
	if (!game.hands[uid]) throw httpError(403, 'You are a spectator');

	game.standing[uid] = true;
	game.lastEvent = { kind: 'stand', uid };
	advance(game);
	return { ok: true };
}

/** One point to every player who beat the dealer. */
export function blackjackScores(game) {
	const o = game.outcomes || {};
	return Object.fromEntries(game.players.map((u) => [u, o[u] === 'win' ? 1 : 0]));
}

/**
 * Per-session view. Everyone's up-cards are public in blackjack, so hands are NOT
 * hidden — the one secret is the dealer's hole card, which is masked until the
 * round is done (`phase !== 'done'`). Totals are computed here so the client
 * never has to (and can't miscount the dealer while the hole card is masked).
 */
export function blackjackView(game, uid) {
	const reveal = game.phase === 'done';
	const dealer = reveal
		? { cards: game.dealer, ...handValue(game.dealer) }
		: { cards: [game.dealer[0], { hidden: true }], up: handValue([game.dealer[0]]).total };
	const hands = {};
	for (const [id, h] of Object.entries(game.hands)) hands[id] = { cards: h, ...handValue(h) };
	return {
		type: game.type,
		players: game.players,
		turnIdx: game.turnIdx,
		hands,
		dealer,
		standing: game.standing,
		busted: game.busted,
		phase: game.phase,
		outcomes: game.outcomes,
		lastEvent: game.lastEvent,
		result: game.result
	};
}

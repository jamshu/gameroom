// Go Fish — ask a rival for a rank; collect four of a kind into a "book". Most
// books when the cards run out wins. Isomorphic (no `$lib`/`$env`).
//
// TURN-BASED, SINGLE WRITER: only the asker mutates, and a whole ask (transfer or
// go-fish draw, book collection, turn pass) resolves in one action — so the /api
// route persists with a plain writeState, like chess. The solo bot reuses
// `handRanks` for its (greedy) choice, so bot and human obey one rule set.
import { httpError } from './errors.js';
import { makeDeck, shuffle } from './cards.js';

export function initGoFish(playerUids) {
	if (playerUids.length < 2 || playerUids.length > 6) {
		throw httpError(400, 'Go Fish needs 2 to 6 players');
	}
	const ocean = shuffle(makeDeck());
	const handSize = playerUids.length <= 3 ? 7 : 5; // standard deal
	const hands = {};
	const books = {};
	for (const uid of playerUids) {
		hands[uid] = ocean.splice(0, handSize);
		books[uid] = [];
	}
	const game = {
		type: 'gofish',
		players: [...playerUids],
		turnIdx: 0,
		hands,
		ocean,
		books,
		lastAsk: null, // { asker, target, rank, got } for the UI
		result: null // 'done'
	};
	// A dealt four-of-a-kind books immediately, before anyone acts.
	for (const uid of playerUids) collectBooks(game, uid);
	return game;
}

/** The distinct ranks a hand can legally be asked for. Pure — bot + UI share it. */
export const handRanks = (hand) => [...new Set((hand || []).map((c) => c.r))];

/** Pull any completed four-of-a-kind out of `uid`'s hand into their books. */
function collectBooks(game, uid) {
	const counts = {};
	for (const c of game.hands[uid]) counts[c.r] = (counts[c.r] || 0) + 1;
	for (const [r, n] of Object.entries(counts)) {
		if (n === 4) {
			game.hands[uid] = game.hands[uid].filter((c) => c.r !== Number(r));
			game.books[uid].push(Number(r));
		}
	}
}

const currentUid = (game) => game.players[game.turnIdx];

/** Total books dealt out — 13 means every rank is booked and the game is over. */
const totalBooks = (game) => Object.values(game.books).reduce((n, b) => n + b.length, 0);

/**
 * Hand the turn to the next player who can actually act. An empty-handed player
 * draws one from the ocean to get back in; if the ocean is dry too, they are
 * skipped. If nobody can act, the game is done.
 */
function passTurn(game) {
	const n = game.players.length;
	for (let step = 1; step <= n; step++) {
		const idx = (game.turnIdx + step) % n;
		const uid = game.players[idx];
		if (game.hands[uid].length === 0 && game.ocean.length > 0) {
			game.hands[uid].push(game.ocean.pop());
			collectBooks(game, uid);
		}
		if (game.hands[uid].length > 0) {
			game.turnIdx = idx;
			return;
		}
	}
	game.result = 'done'; // nobody holds a card and the ocean is empty
}

function endIfDone(game) {
	if (totalBooks(game) === 13) game.result = 'done';
}

/**
 * `uid` asks `targetUid` for `rank`. Standard rule: the asker must already hold a
 * card of that rank. A hit (target had some) hands them all over and keeps the
 * turn; a miss sends the asker fishing — a drawn card of the asked rank also
 * keeps the turn, anything else passes it. Mutates `game`.
 */
export function ask(game, uid, targetUid, rank) {
	if (game.result) throw httpError(409, 'Game is finished');
	if (uid !== currentUid(game)) throw httpError(409, 'Not your turn');
	const hand = game.hands[uid];
	if (!hand) throw httpError(403, 'You are a spectator');

	const target = Number(targetUid);
	const r = Number(rank);
	if (!game.players.includes(target)) throw httpError(400, 'No such player');
	if (target === Number(uid)) throw httpError(400, 'You cannot ask yourself');
	if (!Number.isInteger(r) || r < 2 || r > 14) throw httpError(400, 'Not a rank');
	if (!hand.some((c) => c.r === r)) throw httpError(400, 'You must hold a card of the rank you ask for');

	// Asking a target who holds nothing is an automatic "go fish" — not an error.
	// That matters in a 2-player game: if your only opponent has emptied while the
	// ocean still has cards, refusing the ask would stall the game with no move left.
	const taken = game.hands[target].filter((c) => c.r === r);
	let keepTurn;
	if (taken.length > 0) {
		game.hands[target] = game.hands[target].filter((c) => c.r !== r);
		hand.push(...taken);
		game.lastAsk = { asker: Number(uid), target, rank: r, got: taken.length };
		keepTurn = true; // a successful ask earns another turn
	} else {
		let drew = null;
		if (game.ocean.length > 0) {
			drew = game.ocean.pop();
			hand.push(drew);
		}
		game.lastAsk = { asker: Number(uid), target, rank: r, got: 'fish', drewRank: drew?.r ?? null };
		keepTurn = !!drew && drew.r === r; // fished the very rank asked for → go again
	}

	collectBooks(game, uid);
	endIfDone(game);
	if (!game.result && !keepTurn) passTurn(game);
	return { ok: true, keepTurn, result: game.lastAsk };
}

/** One point to whoever holds the most books; a tie pays everyone tied. */
export function gofishWinners(game) {
	if (game.result !== 'done') return [];
	const top = Math.max(0, ...game.players.map((u) => game.books[u].length));
	if (top <= 0) return [];
	return game.players.filter((u) => game.books[u].length === top).map(Number);
}

export function gofishScores(game) {
	const winners = new Set(gofishWinners(game));
	return Object.fromEntries(game.players.map((u) => [u, winners.has(Number(u)) ? 1 : 0]));
}

/**
 * Per-session view. Books are public (they're laid face up), so those are shared;
 * every rival HAND is reduced to a count — the hidden-hand shape sudokuView uses.
 * The caller sees their own hand in full.
 */
export function gofishView(game, uid) {
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
		books: game.books,
		oceanCount: game.ocean.length,
		lastAsk: game.lastAsk,
		result: game.result
	};
}

// Match-3 rules: board dealing, swap legality, cascade resolution and scoring.
//
// ISOMORPHIC BY CONTRACT — relative imports only, no `$lib`/`$env`. Imported by
// shared/gamelogic.js (bundled into the DO by wrangler) AND by the solo page.
// `check:noenv` enforces it.
//
// DETERMINISM IS THE PRODUCT HERE, in a way it isn't for sudoku. The refill
// queue is unbounded, so it can't be dealt up front the way a sudoku grid is:
// every client generates its own tiles from the shared seed. Two players get the
// same STARTING board, then their streams diverge as soon as their moves do —
// which is the intended game, not a bug. What determinism buys is that seed +
// swap log replays to exactly one score, on any runtime. `applySwap` therefore
// takes the rng and every path through it must draw the same number of values,
// or a later replay of the same log would disagree with the score played.
import { makeRng, rngInt } from './rng.js';

export const SIZE = 8; // 8x8 — big enough for cascades, fits a phone portrait
export const CELLS = SIZE * SIZE;
export const KINDS = 6; // tile types, indices 0..5; the UI maps these to emoji

/** Match-3 is played against a clock rather than to a finish. */
export const ROUND_MS = 90_000;

/**
 * How long after the clock runs out a player still has to report their score
 * before the room writes them off at whatever they had.
 *
 * Needed because every player reports independently. Closing the round the
 * instant the FIRST report lands would zero everyone else — they were still
 * mid-request — which is a race where only the fastest connection scores. The
 * round therefore ends when everyone has reported, or when this window has
 * passed and someone asks again, whichever comes first.
 *
 * Sized for a slow phone on a bad connection to complete one POST, not for a
 * player to keep thinking: the board is already frozen when it starts.
 */
export const GRACE_MS = 8_000;

const idx = (r, c) => r * SIZE + c;
const rowOf = (i) => (i / SIZE) | 0;
const colOf = (i) => i % SIZE;

/* --------------------------------- matches -------------------------------- */

/**
 * Every cell that sits in a horizontal or vertical run of 3+ of one kind.
 *
 * Returned as a Set because a cell in BOTH a row run and a column run (an L or
 * T shape) must clear exactly once — collecting into an array would double-count
 * it and inflate the score by the size of the overlap.
 */
export function findMatches(board) {
	const hit = new Set();
	for (let r = 0; r < SIZE; r++) {
		for (let c = 0; c < SIZE - 2; ) {
			const k = board[idx(r, c)];
			let n = 1;
			while (c + n < SIZE && board[idx(r, c + n)] === k) n++;
			if (k != null && n >= 3) for (let j = 0; j < n; j++) hit.add(idx(r, c + j));
			c += n >= 3 ? n : 1;
		}
	}
	for (let c = 0; c < SIZE; c++) {
		for (let r = 0; r < SIZE - 2; ) {
			const k = board[idx(r, c)];
			let n = 1;
			while (r + n < SIZE && board[idx(r + n, c)] === k) n++;
			if (k != null && n >= 3) for (let j = 0; j < n; j++) hit.add(idx(r + j, c));
			r += n >= 3 ? n : 1;
		}
	}
	return hit;
}

/** Are two cells orthogonally adjacent? Diagonals are not swappable. */
export function areAdjacent(a, b) {
	if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
	if (a < 0 || b < 0 || a >= CELLS || b >= CELLS) return false;
	const dr = Math.abs(rowOf(a) - rowOf(b));
	const dc = Math.abs(colOf(a) - colOf(b));
	return dr + dc === 1;
}

/** Would swapping a and b actually match something? Adjacency plus a dry run. */
export function isLegalSwap(board, a, b) {
	if (!areAdjacent(a, b)) return false;
	const t = board.slice();
	[t[a], t[b]] = [t[b], t[a]];
	return findMatches(t).size > 0;
}

/**
 * Does the board still have any move at all? Checked after every settle: a
 * deadlocked board would otherwise strand a solo player and silently end a
 * racer's round early.
 *
 * Only right/down neighbours are tried — every adjacent pair is reachable that
 * way exactly once, so testing all four directions would double the work.
 */
export function hasLegalMove(board) {
	for (let r = 0; r < SIZE; r++) {
		for (let c = 0; c < SIZE; c++) {
			const i = idx(r, c);
			if (c + 1 < SIZE && isLegalSwap(board, i, idx(r, c + 1))) return true;
			if (r + 1 < SIZE && isLegalSwap(board, i, idx(r + 1, c))) return true;
		}
	}
	return false;
}

/* --------------------------------- scoring -------------------------------- */

/**
 * Points for clearing `cleared` tiles at cascade depth `depth` (1 = the swap the
 * player made, 2+ = tiles that fell into a new match on their own).
 *
 * Deeper cascades multiply, so setting one up is worth more than grinding
 * three-in-a-rows, and big single clears get a flat bonus on top. Integer
 * arithmetic throughout — a float score would not survive the JSON round trip
 * to Odoo and back identically on every runtime, and replay validation compares
 * scores exactly.
 */
export function scoreFor(cleared, depth) {
	if (cleared <= 0) return 0;
	const bonus = cleared >= 5 ? 150 : cleared >= 4 ? 50 : 0;
	return (cleared * 10 + bonus) * depth;
}

/**
 * The most a player could plausibly have scored in `elapsedMs`, used by the
 * server to clamp a self-reported score (see the match-3 tradeoff in the plan:
 * the score is client-computed because the refill stream is client-generated).
 *
 * Deliberately loose — this is a floor under absurdity, not an anti-cheat. It
 * rejects the reported million while never touching a genuinely good round.
 *
 * Calibrated, not guessed: 60 swaps of *random* legal play over a full round
 * scores ~5k (see match3-check). The constants below put the 90s ceiling near
 * 50k — an order of magnitude above indifferent play, so skill and a lucky
 * cascade chain have all the headroom they need, while a client claiming six
 * figures is still caught.
 */
export function scoreCeiling(elapsedMs) {
	const seconds = Math.max(1, Math.ceil(elapsedMs / 1000));
	return seconds * 500 + 5000;
}

/* ------------------------------ board dealing ----------------------------- */

/**
 * Refill from the top. Tiles fall straight down their own column, and blanks
 * (null) at the top take fresh kinds from the rng.
 *
 * Column-major and bottom-up so a tile never overtakes the one below it. The rng
 * is drawn per NEW tile in a fixed column order — that fixed order is what makes
 * the stream replayable.
 */
function collapse(board, rng) {
	for (let c = 0; c < SIZE; c++) {
		let write = SIZE - 1;
		for (let r = SIZE - 1; r >= 0; r--) {
			const v = board[idx(r, c)];
			if (v != null) board[idx(write--, c)] = v;
		}
		for (let r = write; r >= 0; r--) board[idx(r, c)] = rngInt(rng, KINDS);
	}
	return board;
}

/**
 * A fresh board: no cell already in a match (the player must earn the first
 * clear, not be handed it) and at least one legal move available.
 *
 * Matched cells are nulled and refilled rather than the whole board re-rolled,
 * so this converges in a couple of passes instead of retrying blindly. The
 * outer guard covers the rare deal that settles with no move at all.
 */
export function makeBoard(rng) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const board = new Array(CELLS);
		for (let i = 0; i < CELLS; i++) board[i] = rngInt(rng, KINDS);
		for (let pass = 0; pass < 50; pass++) {
			const hit = findMatches(board);
			if (!hit.size) break;
			for (const i of hit) board[i] = null;
			collapse(board, rng);
		}
		if (!findMatches(board).size && hasLegalMove(board)) return board;
	}
	// Unreachable in practice; a board is still better than an exception mid-game.
	const board = new Array(CELLS);
	for (let i = 0; i < CELLS; i++) board[i] = i % KINDS;
	return board;
}

/**
 * Rearrange a deadlocked board in place until it has a move again, keeping the
 * exact multiset of tiles the player had. Reached only when `hasLegalMove` is
 * false after a settle.
 */
export function reshuffle(board, rng) {
	for (let attempt = 0; attempt < 50; attempt++) {
		for (let i = board.length - 1; i > 0; i--) {
			const j = rngInt(rng, i + 1);
			[board[i], board[j]] = [board[j], board[i]];
		}
		if (!findMatches(board).size && hasLegalMove(board)) return board;
	}
	return board;
}

/* ---------------------------------- play ---------------------------------- */

/**
 * Play one swap and settle every cascade it triggers.
 *
 * Returns a NEW board — the caller's array is never mutated, so Svelte's runes
 * see a fresh reference and a rejected swap leaves the original untouched.
 *
 * An illegal swap returns `{ ok: false }` having drawn NOTHING from the rng.
 * That is the load-bearing detail for replay: a rejected swap must not advance
 * the stream, or a log replayed by the server would deal different tiles than
 * the client saw and score the round differently.
 */
export function applySwap(board, a, b, rng) {
	if (!isLegalSwap(board, a, b)) return { ok: false, board, gained: 0, cascades: 0 };

	const next = board.slice();
	[next[a], next[b]] = [next[b], next[a]];

	let gained = 0;
	let cascades = 0;
	for (let depth = 1; depth < 200; depth++) {
		const hit = findMatches(next);
		if (!hit.size) break;
		gained += scoreFor(hit.size, depth);
		cascades = depth;
		for (const i of hit) next[i] = null;
		collapse(next, rng);
	}
	// A settle can strand the board with no move left; hand it back playable.
	if (!hasLegalMove(next)) reshuffle(next, rng);

	return { ok: true, board: next, gained, cascades };
}

/**
 * Replay a whole round from its seed and swap log — the same code path the
 * client played, so it yields the same score.
 *
 * Not wired into the finish endpoint today (the server clamps rather than
 * replays, see the plan), but it is what makes that a reversible decision: the
 * swap log is recorded in the game state in exactly this shape.
 */
export function replay(seed, swaps) {
	const rng = makeRng(seed);
	let board = makeBoard(rng);
	let score = 0;
	for (const [a, b] of swaps || []) {
		const res = applySwap(board, a, b, rng);
		if (!res.ok) continue;
		board = res.board;
		score += res.gained;
	}
	return { board, score };
}

/** The starting board for a seeded round, plus the rng positioned to continue. */
export function openRound(seed) {
	const rng = makeRng(seed);
	return { board: makeBoard(rng), rng };
}

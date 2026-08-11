// Candy Survival — the SOLO candy game. Candies drop from the top and pile up in
// their columns (bottom gravity, no auto-refill); you swap to clear matches and
// make room. When the box fills completely, it's game over.
//
// CLIENT / SOLO ONLY. Deliberately NOT in shared/: the multiplayer race is the
// timed sprint and rides on shared/match3.js's deterministic top-refill engine,
// which this must not touch. It only borrows that engine's pure, board-shape
// helpers (findMatches / scoreFor / adjacency / SIZE); the gravity, dropping and
// game-over rules here are survival's own. No seed/replay — solo doesn't need it,
// so plain Math.random is fine.
import { SIZE, CELLS, KINDS, findMatches, scoreFor, areAdjacent } from './shared/match3.js';

const idx = (r, c) => r * SIZE + c;
const rnd = (n) => Math.floor(Math.random() * n);

export { SIZE, CELLS, KINDS };

export const emptyBoard = () => new Array(CELLS).fill(null);

/** How many candies sit in a column (they always rest at the bottom). */
export function colCount(board, c) {
	let n = 0;
	for (let r = 0; r < SIZE; r++) if (board[idx(r, c)] != null) n++;
	return n;
}

/** True once every cell is filled — the box is full, the game is over. */
export const isFull = (board) => board.every((v) => v != null);

/**
 * Tiles fall to the bottom of their own column; the cells they vacate at the top
 * become null. Unlike shared/match3's `collapse`, nothing is spawned to refill —
 * gaps left by a clear stay empty until new candies drop into them. Mutates.
 */
export function gravity(board) {
	for (let c = 0; c < SIZE; c++) {
		let write = SIZE - 1;
		for (let r = SIZE - 1; r >= 0; r--) {
			const v = board[idx(r, c)];
			if (v != null) {
				board[idx(r, c)] = null;
				board[idx(write, c)] = v;
				write--;
			}
		}
	}
	return board;
}

function wouldMatch(board, a, b) {
	const t = board.slice();
	[t[a], t[b]] = [t[b], t[a]];
	return findMatches(t).size > 0;
}

/** A swap is legal only between two adjacent, non-empty tiles that make a match. */
export function legalSwap(board, a, b) {
	if (!areAdjacent(a, b)) return false;
	if (board[a] == null || board[b] == null) return false;
	return wouldMatch(board, a, b);
}

/** Is any clearing move available right now? (Drops keep coming, so a momentary
 *  no-move board is not a loss — only a full one is — but the deal uses this to
 *  hand out a playable start.) */
export function hasLegalMove(board) {
	for (let r = 0; r < SIZE; r++) {
		for (let c = 0; c < SIZE; c++) {
			const i = idx(r, c);
			if (board[i] == null) continue;
			if (c + 1 < SIZE && board[idx(r, c + 1)] != null && wouldMatch(board, i, idx(r, c + 1))) return true;
			if (r + 1 < SIZE && board[idx(r + 1, c)] != null && wouldMatch(board, i, idx(r + 1, c))) return true;
		}
	}
	return false;
}

/**
 * A starting board: the bottom `rows` rows filled, gravity-settled, holding no
 * ready-made match (you earn the first clear) and at least one legal move.
 */
export function dealStart(rows = 4) {
	for (let attempt = 0; attempt < 80; attempt++) {
		const b = emptyBoard();
		for (let r = SIZE - rows; r < SIZE; r++) for (let c = 0; c < SIZE; c++) b[idx(r, c)] = rnd(KINDS);
		// re-roll any matched cell in place until the deal is clean (positions are
		// fixed, so no gravity/refill pass is needed between rolls)
		let clean = false;
		for (let pass = 0; pass < 80; pass++) {
			const hit = findMatches(b);
			if (!hit.size) {
				clean = true;
				break;
			}
			for (const i of hit) b[i] = rnd(KINDS);
		}
		if (clean && hasLegalMove(b)) return b;
	}
	// Unreachable in practice; a striped fallback still has moves and no matches.
	const b = emptyBoard();
	for (let r = SIZE - rows; r < SIZE; r++) for (let c = 0; c < SIZE; c++) b[idx(r, c)] = (r + c) % KINDS;
	return b;
}

/**
 * Resolve every cascade a settled-but-matching board contains, as the animatable
 * steps the page draws (matched cells, then the board after they fall). Pure —
 * returns a new board.
 */
export function settleSteps(board) {
	const next = board.slice();
	let gained = 0;
	let depth = 0;
	const steps = [];
	for (;;) {
		const hit = findMatches(next);
		if (!hit.size) break;
		depth++;
		const g = scoreFor(hit.size, depth);
		gained += g;
		const matched = [...hit];
		for (const i of hit) next[i] = null;
		gravity(next);
		steps.push({ matched, depth, gained: g, collapsed: next.slice() });
	}
	return { board: next, gained, cascades: depth, steps };
}

/** Play a swap and settle the cascade it triggers. `{ ok:false }` for an illegal one. */
export function applySwap(board, a, b) {
	if (!legalSwap(board, a, b)) return { ok: false };
	const next = board.slice();
	[next[a], next[b]] = [next[b], next[a]];
	const swapped = next.slice();
	const s = settleSteps(next);
	return { ok: true, swapped, board: s.board, gained: s.gained, cascades: s.cascades, steps: s.steps };
}

/**
 * Drop `count` new candies into distinct non-full columns, each landing on top of
 * its pile. Returns the new board, the indices dropped into (for the fall-in
 * animation) and whether the box is now full — `over` is the only loss condition.
 *
 * A full column is skipped and the candy goes to another; the game ends only when
 * NO column has room, i.e. the whole box is full.
 */
export function dropTick(board, count = 2) {
	const next = board.slice();
	if (isFull(next)) return { board: next, placed: [], over: true };

	const cols = [];
	for (let c = 0; c < SIZE; c++) if (colCount(next, c) < SIZE) cols.push(c);
	for (let i = cols.length - 1; i > 0; i--) {
		const j = rnd(i + 1);
		[cols[i], cols[j]] = [cols[j], cols[i]];
	}

	const placed = [];
	for (const c of cols) {
		if (placed.length >= count) break;
		const r = SIZE - colCount(next, c) - 1; // the empty cell just above the pile
		next[idx(r, c)] = rnd(KINDS);
		placed.push(idx(r, c));
	}
	return { board: next, placed, over: isFull(next) };
}

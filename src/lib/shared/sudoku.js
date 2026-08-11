// Sudoku rules: puzzle generation, solving and completion checks.
//
// ISOMORPHIC BY CONTRACT — relative imports only, no `$lib`/`$env`. Imported by
// shared/gamelogic.js (which wrangler bundles into the DO) AND by the solo page,
// so both the race and the offline game run the same rules. `check:noenv`
// enforces the import discipline.
//
// Grids are plain 81-element Arrays, row-major, 0 = blank. Plain Arrays and not
// Uint8Array deliberately: game state is JSON-serialized into Odoo and pushed
// over the socket, and a typed array round-trips through JSON.stringify as
// `{"0":5,"1":3,…}` — an object, silently, with no error anywhere.
//
// WHO PAYS FOR GENERATION: only the side that deals the puzzle. The carve loop
// below runs a uniqueness solve per removed cell, which is the one expensive
// thing in this file. It runs ONCE per game on the server (or once per puzzle in
// the solo tab) and the resulting `puzzle` is then shipped verbatim — clients
// never re-derive it from the seed. Only `solution` is withheld (see gameView).
import { makeRng, shuffle } from './rng.js';

/** Which 3x3 box each cell belongs to, precomputed — the solver's hot path. */
const BOX = new Uint8Array(81);
for (let i = 0; i < 81; i++) {
	BOX[i] = Math.floor(Math.floor(i / 9) / 3) * 3 + Math.floor((i % 9) / 3);
}

const ALL = 0x1ff; // bits 0..8 = digits 1..9

/**
 * What a wrong entry costs: the player's input freezes for ten seconds.
 *
 * A freeze rather than an after-the-fact time adjustment, because the race is
 * won by the first player to complete their grid — a penalty added to a finish
 * time nobody compares would be decorative. Ten seconds of real race time is a
 * genuine cost, and it keeps "first to finish wins" literally true.
 *
 * Lives here so the server rule, the race UI and the solo page cannot drift:
 * solo doubles as practice for the race, so the penalty must be the same one.
 */
export const FREEZE_MS = 10_000;

/** How many givens each difficulty aims to leave. Fewer givens = harder. */
export const GIVENS = { easy: 45, medium: 36, hard: 30 };
export const DIFFICULTIES = Object.keys(GIVENS);

/**
 * How many candidate digits a mask holds. A 512-entry table because the mask is
 * only ever 9 bits: exact by construction and faster than any bit trick.
 *
 * Was a hand-rolled SWAR popcount, which is why this is spelled out. The 16-bit
 * variant of that trick overflows its final multiply above 4 set bits and
 * returned 72 for a full 9-candidate mask. Nothing crashed: the dead-end test
 * (`=== 0`) still worked and most real cells have few candidates, so puzzles
 * still generated — but an empty grid scored `best === -1` and was counted as
 * SOLVED, so `solveCount` could call an ambiguous puzzle unique. Exactly the
 * property the race depends on, failing silently.
 */
const POPCOUNT = new Uint8Array(ALL + 1);
for (let i = 1; i <= ALL; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

/**
 * How many distinct solutions `grid` admits, counted up to `limit` and no
 * further — callers only ever ask "exactly one?", so counting past 2 is wasted
 * work on the branchiest grids.
 *
 * Bitmask candidates + minimum-remaining-values: always branch on the most
 * constrained empty cell, and bail the moment one has no candidates at all.
 * Naive cell-order backtracking explores orders of magnitude more nodes and
 * turns the carve loop below from milliseconds into seconds.
 *
 * ASSUMES a consistent grid (no digit repeated in a row/column/box). The masks
 * are built by OR-ing, so a grid that already contradicts itself would be scored
 * against a mask that lost the duplicate. Every caller here carves down from a
 * complete valid solution; `isConsistent` is exported for the ones that don't.
 */
export function solveCount(grid, limit = 2) {
	const g = Uint8Array.from(grid);
	const rows = new Uint16Array(9);
	const cols = new Uint16Array(9);
	const boxes = new Uint16Array(9);
	for (let i = 0; i < 81; i++) {
		const d = g[i];
		if (!d) continue;
		const bit = 1 << (d - 1);
		rows[(i / 9) | 0] |= bit;
		cols[i % 9] |= bit;
		boxes[BOX[i]] |= bit;
	}

	let count = 0;
	const rec = () => {
		let best = -1;
		let bestMask = 0;
		let bestCount = 10;
		for (let i = 0; i < 81; i++) {
			if (g[i]) continue;
			const avail = ~(rows[(i / 9) | 0] | cols[i % 9] | boxes[BOX[i]]) & ALL;
			const c = POPCOUNT[avail];
			if (c === 0) return; // dead end — no digit fits here
			if (c < bestCount) {
				best = i;
				bestMask = avail;
				bestCount = c;
				if (c === 1) break; // can't do better than forced
			}
		}
		if (best === -1) {
			count++; // no empty cells left: a complete solution
			return;
		}
		const r = (best / 9) | 0;
		const c = best % 9;
		const b = BOX[best];
		let m = bestMask;
		while (m) {
			const bit = m & -m;
			m ^= bit;
			g[best] = 32 - Math.clz32(bit);
			rows[r] |= bit;
			cols[c] |= bit;
			boxes[b] |= bit;
			rec();
			g[best] = 0;
			rows[r] ^= bit;
			cols[c] ^= bit;
			boxes[b] ^= bit;
			if (count >= limit) return;
		}
	};
	rec();
	return count;
}

/** Does `grid` repeat a digit in any row, column or box? Blanks are ignored. */
export function isConsistent(grid) {
	const rows = new Uint16Array(9);
	const cols = new Uint16Array(9);
	const boxes = new Uint16Array(9);
	for (let i = 0; i < 81; i++) {
		const d = grid[i];
		if (!d) continue;
		const bit = 1 << (d - 1);
		const r = (i / 9) | 0;
		const c = i % 9;
		const b = BOX[i];
		if (rows[r] & bit || cols[c] & bit || boxes[b] & bit) return false;
		rows[r] |= bit;
		cols[c] |= bit;
		boxes[b] |= bit;
	}
	return true;
}

/**
 * A complete, valid grid — built by construction rather than by search.
 *
 * `((r % 3) * 3 + floor(r / 3) + c) % 9` walks each row by a shift that is
 * distinct for all nine rows and steps by 1 between bands, which satisfies rows,
 * columns and boxes simultaneously. It always succeeds in O(81), where a
 * randomized backtracking fill can thrash — and since every valid grid is a
 * relabelling/permutation of this one, seeding the transform below loses no
 * variety.
 */
function canonicalSolution() {
	const g = new Uint8Array(81);
	for (let r = 0; r < 9; r++) {
		for (let c = 0; c < 9; c++) {
			g[r * 9 + c] = (((r % 3) * 3 + Math.floor(r / 3) + c) % 9) + 1;
		}
	}
	return g;
}

/** A seeded row (or column) order that keeps bands intact — the only kind of
 *  reordering that preserves box structure. Bands shuffle, and rows shuffle
 *  within their own band; a free 9-way shuffle would break the boxes. */
function bandedOrder(rng) {
	const bands = shuffle(rng, [0, 1, 2]);
	const order = [];
	for (const b of bands) for (const r of shuffle(rng, [0, 1, 2])) order.push(b * 3 + r);
	return order;
}

/**
 * A complete grid for `rng` — the canonical one relabelled and permuted.
 *
 * Every step here is a symmetry of Sudoku, so the result is always valid without
 * being checked, and (this is the part the carve loop depends on) applying the
 * same permutation to a puzzle and its solution preserves how many solutions the
 * puzzle has.
 */
function seededSolution(rng) {
	const base = canonicalSolution();
	const digits = shuffle(rng, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
	const rowOrder = bandedOrder(rng);
	const colOrder = bandedOrder(rng);
	const flip = rng() < 0.5; // transpose: a genuine symmetry, and doubles the pool

	const out = new Uint8Array(81);
	for (let r = 0; r < 9; r++) {
		for (let c = 0; c < 9; c++) {
			const src = flip ? colOrder[c] * 9 + rowOrder[r] : rowOrder[r] * 9 + colOrder[c];
			out[r * 9 + c] = digits[base[src] - 1];
		}
	}
	return out;
}

/**
 * Deal a puzzle. Same seed + same difficulty => byte-identical result on the
 * server, in any browser and in node — which is what lets a race be fair and
 * lets the check script assert determinism.
 *
 * Removal stops at the difficulty's target, or earlier if no further cell can be
 * emptied without admitting a second solution. Returning a slightly easier
 * puzzle is strictly better than the alternatives (looping forever, or shipping
 * an ambiguous grid two players would "correctly" finish differently), so
 * `givens` is reported rather than promised.
 */
export function generate(seed, difficulty = 'medium') {
	const rng = makeRng(seed);
	const solution = seededSolution(rng);
	const target = GIVENS[difficulty] ?? GIVENS.medium;

	const puzzle = Uint8Array.from(solution);
	let givens = 81;
	// Shuffled removal order, so difficulty doesn't correlate with grid position
	// the way a top-left-first sweep would.
	for (const i of shuffle(rng, Array.from({ length: 81 }, (_, k) => k))) {
		if (givens <= target) break;
		const d = puzzle[i];
		puzzle[i] = 0;
		if (solveCount(puzzle, 2) === 1) givens--;
		else puzzle[i] = d; // ambiguous without it — the cell has to stay
	}

	return {
		difficulty: GIVENS[difficulty] ? difficulty : 'medium',
		puzzle: Array.from(puzzle),
		solution: Array.from(solution),
		givens
	};
}

/* ------------------------------ play helpers ------------------------------ */

/** Cells a player may type into: the blanks in the dealt puzzle. */
export const isEditable = (puzzle, i) => puzzle[i] === 0;

/** How many editable cells the player has filled, and how many there are. */
export function progressOf(puzzle, filled) {
	let done = 0;
	let total = 0;
	for (let i = 0; i < 81; i++) {
		if (puzzle[i] !== 0) continue;
		total++;
		if (filled?.[i]) done++;
	}
	return { done, total, pct: total ? Math.round((done / total) * 100) : 100 };
}

/**
 * Is this board finished? True only when every editable cell holds a digit.
 *
 * Correctness is NOT re-checked here and must not be: the server rejects wrong
 * digits at entry time, so a full board is correct by construction. Re-deriving
 * it would need the solution, which is exactly what never reaches the client.
 */
export function isComplete(puzzle, filled) {
	const { done, total } = progressOf(puzzle, filled);
	return done === total;
}

/** Row/column/box of a cell — used by the board UI to highlight peers. */
export const rowOf = (i) => (i / 9) | 0;
export const colOf = (i) => i % 9;
export const boxOf = (i) => BOX[i];

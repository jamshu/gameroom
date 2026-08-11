// Runnable check for the sudoku engine.
// Run: node src/lib/shared/sudoku-check.js
//
// Two properties carry the whole game and are asserted here rather than trusted:
//
//   UNIQUENESS — the race declares the first player to fill their grid the
//   winner without re-checking their answers, because wrong digits are rejected
//   at entry. That only holds if the dealt puzzle admits exactly ONE solution.
//   An ambiguous grid would let two players "correctly" finish differently and
//   the loser would have no way to see why.
//
//   DETERMINISM — the puzzle is dealt from a seed. Same seed must mean the same
//   grid in the DO, in every browser and here in node, or a race is not a race.
import assert from 'node:assert';
import {
	generate, solveCount, isConsistent, progressOf, isComplete,
	GIVENS, DIFFICULTIES, rowOf, colOf, boxOf
} from './sudoku.js';

// (a) every difficulty deals a consistent, uniquely-solvable puzzle whose givens
//     agree with its solution. Several seeds each, because a generator that only
//     works on the seed the author happened to try is the classic failure.
{
	for (const d of DIFFICULTIES) {
		for (const seed of ['alpha', 'beta', 'a3f9-c1', '', '0']) {
			const { puzzle, solution, givens, difficulty } = generate(seed, d);

			assert.equal(difficulty, d);
			assert.equal(puzzle.length, 81);
			assert.equal(solution.length, 81);

			assert.ok(solution.every((v) => v >= 1 && v <= 9), `${d}/${seed}: solution has a blank`);
			assert.ok(isConsistent(solution), `${d}/${seed}: solution repeats a digit`);
			assert.ok(
				puzzle.every((v, i) => v === 0 || v === solution[i]),
				`${d}/${seed}: a given contradicts the solution`
			);
			assert.equal(
				solveCount(puzzle, 2), 1,
				`${d}/${seed}: puzzle is ambiguous — two players could both "win" with different grids`
			);
			assert.equal(puzzle.filter((v) => v !== 0).length, givens, 'reported givens must be real');
		}
	}
}

// (b) difficulty actually differs, and reaches its target. `givens` is reported
//     rather than promised (removal stops early if nothing else can go), so this
//     asserts it never SILENTLY hands out an easier puzzle than asked for.
{
	for (const d of DIFFICULTIES) {
		const { givens } = generate('target-' + d, d);
		assert.equal(givens, GIVENS[d], `${d}: expected to reach its target`);
	}
	assert.ok(GIVENS.easy > GIVENS.medium && GIVENS.medium > GIVENS.hard, 'harder means fewer givens');
}

// (c) determinism — the property the race rests on.
{
	const a = generate('same-seed', 'hard');
	const b = generate('same-seed', 'hard');
	assert.deepEqual(a, b, 'same seed must deal the same puzzle everywhere');

	const c = generate('other-seed', 'hard');
	assert.notDeepEqual(a.puzzle, c.puzzle, 'different seeds must deal different puzzles');

	// difficulty is part of the deal, not a post-filter
	assert.notDeepEqual(generate('s', 'easy').puzzle, generate('s', 'hard').puzzle);
}

// (d) an unknown difficulty falls back rather than dealing an 81-blank grid —
//     the same "unknown id renders instead of crashing" rule gameById follows.
{
	const g = generate('x', 'impossible');
	assert.equal(g.difficulty, 'medium');
	assert.equal(g.givens, GIVENS.medium);
	assert.equal(solveCount(g.puzzle, 2), 1);
}

// (e) solveCount stops at `limit` and recognises the degenerate cases. An empty
//     grid has billions of solutions; the point is that it returns promptly at 2.
{
	assert.equal(solveCount(new Array(81).fill(0), 2), 2, 'empty grid: stops at the limit');
	const solved = generate('e', 'easy').solution;
	assert.equal(solveCount(solved, 2), 1, 'an already-complete grid solves as itself');

	// one blank in a complete grid can only be filled one way
	const oneHole = solved.slice();
	oneHole[40] = 0;
	assert.equal(solveCount(oneHole, 2), 1);
}

// (e2) solveCount must actually DETECT ambiguity — regression guard.
//
// A hand-rolled SWAR popcount here once overflowed above 4 candidate bits and
// reported 72 for a 9-candidate cell. Nothing threw: puzzles still generated,
// because real cells mostly have few candidates. What broke was this — grids
// whose empty cells all looked "over-full" were scored as already solved, so an
// ambiguous puzzle could be certified unique and two racers could both finish
// "correctly" with different grids. Asserting uniqueness alone would not have
// caught it; only asserting that non-uniqueness is SEEN does.
{
	const solved = generate('amb', 'easy').solution;

	// Blank every cell holding a 3 or a 7. Swapping the two digits throughout is
	// always another valid completion, so the grid is guaranteed ambiguous for
	// ANY valid solution — which a deadly rectangle is not: a shift-pattern grid
	// provably contains none, since rows within a band differ by a shift of 3 and
	// the four cells can never line up.
	//
	// At least two, not exactly two: the 18 holes admit further rearrangements
	// beyond the straight swap. Detection is the property under test.
	const planted = solved.map((v) => (v === 3 || v === 7 ? 0 : v));
	assert.equal(planted.filter((v) => v === 0).length, 18, 'two digits, nine cells each');
	assert.equal(solveCount(planted, 2), 2, 'an ambiguous grid must report more than one solution');

	// and the empty grid — the degenerate case the popcount bug scored as solved
	assert.equal(solveCount(new Array(81).fill(0), 2), 2);
}

// (f) isConsistent catches the duplicates solveCount's masks would swallow.
{
	const g = generate('f', 'easy').solution.slice();
	assert.ok(isConsistent(g));
	// plant a duplicate in a row by copying its neighbour
	const dup = g.slice();
	dup[1] = dup[0];
	assert.ok(!isConsistent(dup), 'a repeated digit in a row is inconsistent');
	assert.ok(isConsistent(new Array(81).fill(0)), 'blanks are ignored');
}

// (g) progress/completion, as the rival ticker and the finish check use them.
//     Counted over EDITABLE cells only — a player who is handed 45 givens has
//     not started at 55%.
{
	const { puzzle, solution } = generate('g', 'medium');
	const empty = {};
	const p0 = progressOf(puzzle, empty);
	assert.equal(p0.done, 0);
	assert.equal(p0.pct, 0, 'givens do not count as progress');
	assert.equal(p0.total, puzzle.filter((v) => v === 0).length);
	assert.ok(!isComplete(puzzle, empty));

	// fill every blank with the right digit
	const filled = {};
	for (let i = 0; i < 81; i++) if (puzzle[i] === 0) filled[i] = solution[i];
	const p1 = progressOf(puzzle, filled);
	assert.equal(p1.done, p1.total);
	assert.equal(p1.pct, 100);
	assert.ok(isComplete(puzzle, filled), 'a full board is finished');

	// half-filled reads as partial progress, and a missing entry is not progress
	const half = {};
	const blanks = puzzle.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
	for (const i of blanks.slice(0, Math.floor(blanks.length / 2))) half[i] = solution[i];
	const p2 = progressOf(puzzle, half);
	assert.ok(p2.done > 0 && p2.done < p2.total);
	assert.ok(p2.pct > 0 && p2.pct < 100);
	assert.ok(!isComplete(puzzle, half));

	assert.equal(progressOf(puzzle, undefined).done, 0, 'a player who never moved does not crash it');
}

// (h) cell geometry, used by the board UI to highlight peers.
{
	assert.equal(rowOf(0), 0); assert.equal(colOf(0), 0); assert.equal(boxOf(0), 0);
	assert.equal(rowOf(80), 8); assert.equal(colOf(80), 8); assert.equal(boxOf(80), 8);
	assert.equal(boxOf(4), 1, 'r0c4 is the top-middle box');
	assert.equal(boxOf(30), 4, 'r3c3 is the centre box');
	assert.equal(boxOf(60), 8, 'r6c6 is the bottom-right box');
	assert.equal(boxOf(54), 6, 'r6c0 is the bottom-left box');
}

// (i) generation is cheap enough to run inside a request. It is the one
//     expensive thing in the module (a uniqueness solve per removed cell), and
//     it runs on game start, so a regression here is a user-visible stall.
{
	const t0 = Date.now();
	for (let i = 0; i < 20; i++) generate('bench-' + i, 'hard');
	const ms = Date.now() - t0;
	assert.ok(ms < 3000, `20 hard puzzles took ${ms}ms — generation has regressed badly`);
}

console.log('sudoku-check: all assertions passed');

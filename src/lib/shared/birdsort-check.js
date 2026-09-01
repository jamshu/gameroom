// Runnable check for the bird-sort engine.
// Run: node src/lib/shared/birdsort-check.js
//
// Two properties carry the game and are asserted, not trusted:
//
//   SOLVABILITY — the race declares the first player to sort their tubes the
//   winner. A dealt puzzle that cannot be sorted would let the race never end.
//   `genTubes` must only ever hand out solvable boards.
//
//   DETERMINISM — the puzzle is dealt from a seed. Same seed must mean the same
//   board in the DO, every browser and here in node, or a race is not a race.
import assert from 'node:assert';
import {
	genTubes, solvable, isSolved, moveLegal, applyMove, topRun, sortedCount,
	progressOf, solvedTubes, HEIGHT, COLORS, EMPTY, TUBES
} from './birdsort.js';

// (a) every seed deals a solvable, well-formed, not-already-solved board.
{
	for (const seed of ['alpha', 'beta', 'a3f9-c1', '', '0', 'kid']) {
		const tubes = genTubes(seed);
		assert.equal(tubes.length, TUBES, `${seed}: wrong tube count`);
		assert.ok(tubes.every((t) => t.length <= HEIGHT), `${seed}: a tube overflows`);
		// conservation: exactly HEIGHT of each colour, EMPTY tubes empty
		const counts = new Array(COLORS).fill(0);
		let empties = 0;
		for (const t of tubes) {
			if (t.length === 0) empties++;
			for (const b of t) counts[b]++;
		}
		assert.ok(counts.every((n) => n === HEIGHT), `${seed}: colour counts off`);
		assert.ok(empties >= EMPTY, `${seed}: missing empty tubes`);
		assert.ok(!isSolved(tubes), `${seed}: dealt an already-solved board`);
		assert.ok(solvable(tubes), `${seed}: dealt an UNSOLVABLE board`);
	}
}

// (b) determinism — the property the race rests on.
{
	assert.deepEqual(genTubes('same'), genTubes('same'), 'same seed must deal the same board');
	assert.notDeepEqual(genTubes('one'), genTubes('two'), 'different seeds must differ');
}

// (c) isSolved + solvable recognise the degenerate cases.
{
	assert.ok(isSolved(solvedTubes()), 'the solved board reads as solved');
	assert.ok(solvable(solvedTubes()), 'an already-solved board is solvable');
	// a deadlock: two half tubes, mismatched tops, no empty — no legal move, unsolved
	assert.ok(!solvable([[0, 1], [1, 0]]), 'a deadlocked board is unsolvable');
}

// (d) topRun / moveLegal / applyMove pour semantics.
{
	assert.deepEqual(topRun([0, 1, 1, 1]), { color: 1, count: 3 });
	assert.deepEqual(topRun([]), { color: -1, count: 0 });

	const t = [[2, 2], [2], []]; // pour top of tube0 onto tube1 (same colour) or empty tube2
	assert.ok(moveLegal(t, 0, 1), 'same colour, room -> legal');
	assert.ok(moveLegal(t, 0, 2), 'onto empty -> legal');
	assert.ok(!moveLegal(t, 2, 0), 'empty source -> illegal');
	assert.ok(!moveLegal(t, 0, 0), 'self -> illegal');

	const after = applyMove(t, 0, 1); // whole top run of 2s (two of them) but only 3 fit? tube1 has room for 3
	assert.deepEqual(after, [[], [2, 2, 2], []], 'pours the whole run into the room available');
	assert.deepEqual(t, [[2, 2], [2], []], 'inputs are untouched (immutable)');

	// respects capacity: pour into a nearly-full tube fills only what fits
	const cap = [[0, 0, 0], [0, 0]]; // HEIGHT 4: tube1 has room for 2, tube0 top-run is 3
	const capped = applyMove(cap, 0, 1);
	assert.deepEqual(capped, [[0], [0, 0, 0, 0]], 'only what fits is poured');

	assert.equal(applyMove([[0], []], 1, 0), null, 'illegal move returns null');
}

// (e) sorting a generated board actually reaches isSolved via legal moves — a
//     stronger statement than solvable(): it exercises applyMove end to end.
{
	// reuse the solver's search but return the solving path
	const tubes = genTubes('playable');
	assert.ok(replaySolves(tubes), 'a dealt board can be driven to solved by legal moves');
}

// (f) progress/sortedCount as the ticker reads them.
{
	assert.equal(sortedCount(solvedTubes()), COLORS, 'solved board: every colour complete');
	assert.deepEqual(progressOf(solvedTubes()), { done: COLORS, total: COLORS, pct: 100 });
	assert.equal(progressOf(genTubes('p')).done < COLORS, true, 'a fresh deal is not complete');
}

// (g) generation is cheap enough to run inside a request.
{
	const t0 = Date.now();
	for (let i = 0; i < 30; i++) genTubes('bench-' + i);
	const ms = Date.now() - t0;
	assert.ok(ms < 3000, `30 deals took ${ms}ms — generation has regressed`);
}

/** DFS that returns whether a solving sequence of legal pours exists AND drives
 *  the board to isSolved along the way (guards applyMove, not just moveLegal). */
function replaySolves(start) {
	const seen = new Set();
	const key = (t) => t.map((x) => x.join(',')).sort().join('|');
	const stack = [start];
	let nodes = 0;
	while (stack.length) {
		if (++nodes > 200000) return false;
		const cur = stack.pop();
		if (isSolved(cur)) return true;
		const k = key(cur);
		if (seen.has(k)) continue;
		seen.add(k);
		for (let f = 0; f < cur.length; f++)
			for (let to = 0; to < cur.length; to++) {
				const nx = applyMove(cur, f, to);
				if (nx && !seen.has(key(nx))) stack.push(nx);
			}
	}
	return false;
}

console.log('birdsort-check: all assertions passed');

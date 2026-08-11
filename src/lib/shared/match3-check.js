// Runnable check for the match-3 engine.
// Run: node src/lib/shared/match3-check.js
//
// The race deals one seeded board and lets both players swipe their own copy.
// That is only fair if the engine is exactly deterministic — same seed and same
// swaps must produce the same tiles and the same score in the DO, in a browser
// and here in node. Everything below exists to pin that down, plus the two
// fairness properties a player would notice immediately: a fresh board never
// hands out a free match, and never deadlocks.
import assert from 'node:assert';
import { makeRng } from './rng.js';
import {
	SIZE, CELLS, KINDS, ROUND_MS,
	makeBoard, openRound, findMatches, areAdjacent, isLegalSwap, hasLegalMove,
	applySwap, reshuffle, replay, scoreFor, scoreCeiling
} from './match3.js';

/** Plays a deterministic pseudo-random round; the shared driver for the tests
 *  below that need a realistic game rather than a hand-built board. */
function playRound(seed, maxSwaps = 60) {
	const { board: start, rng } = openRound(seed);
	const choose = makeRng('moves-' + seed);
	let board = start;
	let score = 0;
	const log = [];
	for (let t = 0; t < maxSwaps; t++) {
		const moves = [];
		for (let i = 0; i < CELLS; i++) {
			for (const j of [i + 1, i + SIZE]) if (isLegalSwap(board, i, j)) moves.push([i, j]);
		}
		if (!moves.length) break;
		const [a, b] = moves[Math.floor(choose() * moves.length)];
		const res = applySwap(board, a, b, rng);
		assert.ok(res.ok, 'a move taken from legalSwaps must apply');
		board = res.board;
		score += res.gained;
		log.push([a, b]);
	}
	return { board, score, log };
}

// (a) a fresh board is playable: no free match handed out, and never deadlocked.
//     Many seeds, because both are probabilistic properties of the deal.
{
	let freeMatch = 0;
	let deadlocked = 0;
	for (let i = 0; i < 200; i++) {
		const b = makeBoard(makeRng('deal-' + i));
		assert.equal(b.length, CELLS);
		assert.ok(b.every((k) => Number.isInteger(k) && k >= 0 && k < KINDS), 'tiles are kind indices');
		if (findMatches(b).size) freeMatch++;
		if (!hasLegalMove(b)) deadlocked++;
	}
	assert.equal(freeMatch, 0, 'a fresh board must not already contain a match');
	assert.equal(deadlocked, 0, 'a fresh board must always have a move');
}

// (b) determinism — the property the race rests on.
{
	assert.deepEqual(openRound('same').board, openRound('same').board, 'same seed, same board');
	assert.notDeepEqual(openRound('same').board, openRound('other').board, 'seeds differ');

	const p1 = playRound('race');
	const p2 = playRound('race');
	assert.deepEqual(p1.log, p2.log, 'same seed must yield the same move sequence');
	assert.equal(p1.score, p2.score, 'and therefore the same score');
	assert.deepEqual(p1.board, p2.board, 'and the same final board');
	assert.ok(p1.log.length > 10, 'the round should actually get played, not stall immediately');
}

// (c) replay reproduces a played round exactly. Not wired into the finish
//     endpoint today — the server clamps instead — but the swap log is stored in
//     this shape so that stays a reversible decision. If this breaks, the stored
//     logs are worthless.
{
	const p = playRound('replay-me');
	const r = replay('replay-me', p.log);
	assert.equal(r.score, p.score, 'a replayed log must score identically');
	assert.deepEqual(r.board, p.board, 'and land on the same board');

	assert.equal(replay('replay-me', []).score, 0, 'an empty log scores nothing');
	assert.deepEqual(replay('replay-me', []).board, openRound('replay-me').board);
	assert.equal(replay('x', undefined).score, 0, 'a missing log does not throw');
}

// (d) an illegal swap changes nothing AND draws nothing from the rng.
//
//     The rng half is the subtle one: if a rejected swap advanced the stream,
//     the client would deal different tiles than a server replaying the same log
//     (which skips rejects), and the two would disagree about the score.
{
	const { board, rng } = openRound('illegal');

	const nonAdjacent = applySwap(board, 0, CELLS - 1, rng);
	assert.equal(nonAdjacent.ok, false);
	assert.deepEqual(nonAdjacent.board, board, 'the board is handed back untouched');
	assert.equal(nonAdjacent.gained, 0);

	// diagonals are not adjacent; out-of-range and non-integers are rejected too
	assert.ok(!areAdjacent(0, SIZE + 1), 'diagonal');
	assert.ok(!areAdjacent(0, -1));
	assert.ok(!areAdjacent(0, CELLS));
	assert.ok(!areAdjacent(0, 1.5));
	assert.ok(!areAdjacent(SIZE - 1, SIZE), 'wrapping the row edge is not adjacency');
	assert.ok(areAdjacent(0, 1) && areAdjacent(0, SIZE), 'right and down are');

	// the stream is untouched by rejects: two runs that differ only in how many
	// illegal swaps they attempt must stay in lockstep
	const clean = openRound('illegal');
	const noisy = openRound('illegal');
	for (let i = 0; i < 5; i++) applySwap(noisy.board, 0, CELLS - 1, noisy.rng);
	assert.equal(clean.rng(), noisy.rng(), 'a rejected swap must not advance the rng');
}

// (e) a legal swap clears something, scores something, and leaves the board
//     settled and playable — the post-conditions the UI assumes.
{
	const { board, rng } = openRound('legal');
	let found = null;
	for (let i = 0; i < CELLS && !found; i++) {
		for (const j of [i + 1, i + SIZE]) if (isLegalSwap(board, i, j)) { found = [i, j]; break; }
	}
	assert.ok(found, 'a fresh board has a legal swap');

	const res = applySwap(board, found[0], found[1], rng);
	assert.ok(res.ok);
	assert.ok(res.gained > 0, 'a legal swap always clears at least one run');
	assert.ok(res.cascades >= 1);
	assert.notEqual(res.board, board, 'a new array is returned, not a mutation');
	assert.deepEqual(board, openRound('legal').board, 'and the input is genuinely unchanged');
	assert.equal(findMatches(res.board).size, 0, 'the board is left settled');
	assert.ok(hasLegalMove(res.board), 'and playable');
	assert.ok(res.board.every((k) => Number.isInteger(k) && k >= 0 && k < KINDS), 'refilled cleanly');
}

// (f) findMatches counts an overlapping cell once. An L or T shape shares its
//     corner between a row run and a column run; collecting into an array would
//     double-count it and quietly inflate every cascade score.
{
	const b = new Array(CELLS).fill(0);
	// make the background non-matching, then plant one L of kind 1
	for (let i = 0; i < CELLS; i++) b[i] = (((i / SIZE) | 0) + i) % KINDS;
	for (let c = 0; c < 3; c++) b[c] = 1; // row run at r0
	for (let r = 0; r < 3; r++) b[r * SIZE] = 1; // column run sharing cell 0
	const hit = findMatches(b);
	assert.equal(hit.size, 5, 'three across + three down sharing a corner is five cells, not six');
	assert.ok(hit.has(0), 'the shared corner is included');
}

// (g) scoring: monotonic in tiles cleared, multiplied by cascade depth, integer.
{
	assert.equal(scoreFor(0, 1), 0);
	assert.equal(scoreFor(-3, 1), 0, 'nonsense input scores nothing rather than negative');
	assert.ok(scoreFor(4, 1) > scoreFor(3, 1), 'longer runs pay more');
	assert.ok(scoreFor(5, 1) > scoreFor(4, 1));
	assert.equal(scoreFor(3, 2), scoreFor(3, 1) * 2, 'depth multiplies');
	assert.ok(scoreFor(3, 3) > scoreFor(3, 1), 'cascades are worth chasing');
	for (const [n, d] of [[3, 1], [4, 2], [5, 3], [9, 4]]) {
		assert.ok(Number.isInteger(scoreFor(n, d)), 'scores stay integer for the JSON round trip');
	}
}

// (h) the server-side clamp is calibrated, not guessed: comfortably above a real
//     round, far below a fabricated one. If either side of this fails the clamp
//     is either rejecting honest players or waving through nonsense.
{
	const real = playRound('ceiling', 90).score;
	const ceiling = scoreCeiling(ROUND_MS);
	assert.ok(ceiling > real * 3, `ceiling ${ceiling} must not threaten a real round (${real})`);
	assert.ok(ceiling < 1_000_000, 'and must still reject a fabricated score');
	assert.ok(scoreCeiling(0) > 0, 'a zero-length round still has a positive ceiling');
	assert.ok(scoreCeiling(ROUND_MS) > scoreCeiling(1000), 'longer rounds allow more');
}

// (i) reshuffle keeps the player's tiles and hands back a playable board — it is
//     reached mid-round, so silently changing the tile mix would be a cheat.
{
	const b = makeBoard(makeRng('shuffle'));
	const before = [...b].sort((x, y) => x - y);
	const after = reshuffle(b.slice(), makeRng('s2'));
	assert.deepEqual([...after].sort((x, y) => x - y), before, 'the tile multiset is preserved');
	assert.equal(findMatches(after).size, 0, 'and it is settled');
	assert.ok(hasLegalMove(after), 'and playable');
}

console.log('match3-check: all assertions passed');

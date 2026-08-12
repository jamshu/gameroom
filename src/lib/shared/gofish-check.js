// Runnable check for Go Fish. Run: node src/lib/shared/gofish-check.js
import assert from 'node:assert';
import {
	initGoFish, ask, handRanks, gofishScores, gofishWinners, gofishView
} from './gofish.js';

// (a) a fresh deal — 7 each for <=3 players, the rest is the ocean.
{
	const g = initGoFish([1, 2]);
	assert.equal(g.hands[1].length, 7);
	assert.equal(g.hands[2].length, 7);
	assert.equal(g.ocean.length, 52 - 14);
	assert.deepEqual(g.books, { 1: [], 2: [] });
}

// (b) a successful ask transfers every matching card AND keeps the turn.
{
	const g = initGoFish([1, 2]);
	g.hands[1] = [{ r: 5, s: 0 }, { r: 9, s: 1 }];
	g.hands[2] = [{ r: 5, s: 2 }, { r: 5, s: 3 }, { r: 7, s: 0 }];
	g.turnIdx = 0;
	const res = ask(g, 1, 2, 5);
	assert.equal(res.keepTurn, true, 'a hit earns another turn');
	assert.equal(g.turnIdx, 0, 'still player 1');
	assert.equal(g.hands[1].filter((c) => c.r === 5).length, 3, 'took both fives');
	assert.equal(g.hands[2].some((c) => c.r === 5), false, 'target gave them all up');
	assert.equal(res.result.got, 2);
}

// (c) collecting the fourth of a rank books it and removes it from the hand.
{
	const g = initGoFish([1, 2]);
	g.hands[1] = [{ r: 5, s: 0 }, { r: 5, s: 1 }, { r: 5, s: 2 }];
	g.hands[2] = [{ r: 5, s: 3 }, { r: 8, s: 0 }];
	g.turnIdx = 0;
	ask(g, 1, 2, 5);
	assert.deepEqual(g.books[1], [5], 'four fives booked');
	assert.equal(g.hands[1].some((c) => c.r === 5), false, 'the book left the hand');
}

// (d) a miss goes fishing; a non-matching draw passes the turn.
{
	const g = initGoFish([1, 2]);
	g.hands[1] = [{ r: 5, s: 0 }];
	g.hands[2] = [{ r: 9, s: 1 }];
	g.ocean = [{ r: 3, s: 2 }]; // pop() serves this — not a 5, so the turn passes
	g.turnIdx = 0;
	const res = ask(g, 1, 2, 5);
	assert.equal(res.keepTurn, false);
	assert.equal(g.turnIdx, 1, 'turn passed to player 2');
	assert.ok(g.hands[1].some((c) => c.r === 3), 'drew the ocean card');
}

// (e) fishing the very rank asked for keeps the turn.
{
	const g = initGoFish([1, 2]);
	g.hands[1] = [{ r: 5, s: 0 }];
	g.hands[2] = [{ r: 9, s: 1 }];
	g.ocean = [{ r: 5, s: 2 }]; // pop() serves a 5 — the asked rank
	g.turnIdx = 0;
	const res = ask(g, 1, 2, 5);
	assert.equal(res.keepTurn, true, 'fished the asked rank → go again');
	assert.equal(g.turnIdx, 0);
}

// (f) the guards: turn, self-ask, holding the rank, empty target.
{
	const g = initGoFish([1, 2]);
	g.hands[1] = [{ r: 5, s: 0 }];
	g.hands[2] = [{ r: 9, s: 1 }];
	g.turnIdx = 0;
	assert.throws(() => ask(g, 2, 1, 9), /Not your turn/);
	assert.throws(() => ask(g, 1, 1, 5), /cannot ask yourself/);
	assert.throws(() => ask(g, 1, 2, 9), /must hold a card of the rank/, 'asker must hold the rank');
}

// (f2) asking an empty opponent is an automatic go-fish, not a stall (2-player endgame).
{
	const g = initGoFish([1, 2]);
	g.hands[1] = [{ r: 5, s: 0 }];
	g.hands[2] = []; // opponent emptied
	g.ocean = [{ r: 8, s: 1 }]; // a non-5 → miss → turn should pass
	g.turnIdx = 0;
	const res = ask(g, 1, 2, 5);
	assert.equal(res.result.got, 'fish', 'asking an empty player fishes');
	assert.ok(g.hands[1].some((c) => c.r === 8), 'the asker drew from the ocean');
}

// (g) an empty-handed player is refilled from the ocean when the turn reaches them.
{
	const g = initGoFish([1, 2, 3]);
	g.hands[1] = [{ r: 5, s: 0 }];
	g.hands[2] = []; // out of cards — the seat after p1
	g.hands[3] = [{ r: 9, s: 1 }]; // p1 asks p3 (a valid, non-empty target)
	g.ocean = [{ r: 4, s: 0 }, { r: 7, s: 1 }]; // p1 draws 7 (top via pop), then p2 is refilled with 4
	g.turnIdx = 0;
	ask(g, 1, 3, 5); // p3 has no 5 → p1 fishes a 7 (miss) → turn passes toward p2
	assert.equal(g.turnIdx, 1, 'passed to p2');
	assert.equal(g.hands[2].length, 1, 'p2 was dealt back in from the ocean');
}

// (h) the game ends when all 13 ranks are booked; most books wins, ties share.
{
	const g = initGoFish([1, 2]);
	// 7 + 5 = 12 books already down; the 5s about to complete make the 13th, all
	// ranks accounted for (2,3,4,6,7,8,9 | 10,11,12,13,14 | 5).
	g.books[1] = [2, 3, 4, 6, 7, 8, 9]; // 7
	g.books[2] = [10, 11, 12, 13, 14]; // 5
	g.hands[1] = [{ r: 5, s: 0 }, { r: 5, s: 1 }, { r: 5, s: 2 }];
	g.hands[2] = [{ r: 5, s: 3 }];
	g.turnIdx = 0;
	ask(g, 1, 2, 5); // completes the 5s → 13 books total → done
	assert.equal(g.result, 'done');
	assert.deepEqual(gofishWinners(g), [1], '8 books beats 5');
	assert.deepEqual(gofishScores(g), { 1: 1, 2: 0 });
}

// (i) the view hides rival hands but shows public books.
{
	const g = initGoFish([1, 2]);
	const v = gofishView(g, 1);
	assert.ok(Array.isArray(v.hands['1']));
	assert.deepEqual(v.hands['2'], { count: 7 }, 'rival hand is only a count');
	assert.equal(v.ocean, undefined, 'the ocean order never leaves the server');
	assert.equal(typeof v.oceanCount, 'number');
	assert.ok(v.books, 'books are public');
	assert.deepEqual(handRanks([{ r: 5, s: 0 }, { r: 5, s: 1 }, { r: 9, s: 2 }]), [5, 9]);
}

console.log('gofish-check: all assertions passed');

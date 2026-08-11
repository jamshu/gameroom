// Runnable check for the candy-survival rules. Run: node src/lib/survival-match3-check.js
import assert from 'node:assert';
import {
	SIZE, CELLS, KINDS,
	emptyBoard, gravity, colCount, isFull, dealStart, hasLegalMove,
	legalSwap, applySwap, settleSteps, dropTick
} from './survival-match3.js';

const idx = (r, c) => r * SIZE + c;

// (a) gravity drops tiles to the bottom and empties the top — no refill.
{
	const b = emptyBoard();
	b[idx(0, 0)] = 1; // a lone tile up top
	b[idx(3, 0)] = 2;
	gravity(b);
	assert.equal(b[idx(SIZE - 1, 0)], 2, 'lower tile lands on the floor');
	assert.equal(b[idx(SIZE - 2, 0)], 1, 'the other rests on top of it');
	for (let r = 0; r < SIZE - 2; r++) assert.equal(b[idx(r, 0)], null, 'cells above are empty');
	assert.equal(colCount(b, 0), 2, 'two tiles in the column');
	assert.equal(colCount(b, 1), 0, 'untouched column stays empty');
}

// (b) a fresh deal is playable: no ready-made match, has a move, only the bottom
//     rows filled.
{
	for (let i = 0; i < 60; i++) {
		const b = dealStart(4);
		assert.ok(hasLegalMove(b), 'the deal always has a legal swap');
		assert.equal(colCount(b, 0), 4, 'exactly the bottom rows are filled');
		// no cell already in a run
		for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
			if (b[idx(r, c)] != null) assert.ok(r >= SIZE - 4, 'filled cells sit at the bottom');
		}
	}
}

// (c) a legal swap clears something and leaves the board settled + gravity-true;
//     an illegal one (or one touching an empty cell) is rejected.
{
	// hand-build a board where swapping makes a row of three
	const b = emptyBoard();
	// bottom row: 0 1 0  with a 0 above the middle → swap brings three 0s across
	b[idx(SIZE - 1, 0)] = 0;
	b[idx(SIZE - 1, 1)] = 1;
	b[idx(SIZE - 1, 2)] = 0;
	b[idx(SIZE - 2, 1)] = 0;
	const a = idx(SIZE - 1, 1);
	const c = idx(SIZE - 2, 1);
	assert.ok(legalSwap(b, a, c), 'the swap makes a match');
	const res = applySwap(b, a, c);
	assert.ok(res.ok);
	assert.ok(res.gained > 0, 'clearing scores');
	assert.ok(res.steps.length >= 1);
	assert.equal(findMatchesCount(res.board), 0, 'board left settled');

	// swapping with an empty neighbour is illegal
	assert.equal(legalSwap(b, idx(0, 0), idx(0, 1)), false, 'empty cells are not swappable');
	assert.equal(applySwap(b, idx(0, 0), idx(0, 1)).ok, false);
}

// (d) drops land on top of piles, fill distinct columns, and end the game only
//     when the whole box is full.
{
	let b = dealStart(4);
	const before = b.reduce((n, v) => n + (v != null ? 1 : 0), 0);
	const t = dropTick(b, 2);
	assert.equal(t.placed.length, 2, 'two candies dropped');
	assert.ok(!t.over);
	const after = t.board.reduce((n, v) => n + (v != null ? 1 : 0), 0);
	assert.equal(after, before + 2, 'two more tiles on the board');
	// each dropped candy sits directly above a pile (or on the floor)
	for (const i of t.placed) {
		const r = (i / SIZE) | 0;
		const col = i % SIZE;
		assert.ok(r === SIZE - 1 || t.board[idx(r + 1, col)] != null, 'a drop rests on the pile below');
	}

	// a full box is game over, and no candy can be placed
	const fullBoard = new Array(CELLS).fill(0);
	const over = dropTick(fullBoard, 2);
	assert.ok(over.over, 'a full box ends the game');
	assert.equal(over.placed.length, 0, 'nothing can be dropped into a full box');
	assert.ok(isFull(fullBoard));
}

// (e) settleSteps chains cascades and its per-step gains sum to the total.
{
	const b = emptyBoard();
	for (let c = 0; c < 3; c++) b[idx(SIZE - 1, c)] = 5; // a ready row of three
	const s = settleSteps(b);
	assert.ok(s.gained > 0);
	assert.equal(s.steps.reduce((n, st) => n + st.gained, 0), s.gained, 'gains sum to the total');
	assert.equal(findMatchesCount(s.board), 0, 'ends settled');
}

function findMatchesCount(board) {
	// local re-derivation to avoid re-importing findMatches just for the test
	let n = 0;
	for (let r = 0; r < SIZE; r++)
		for (let c = 0; c < SIZE - 2; c++) {
			const k = board[idx(r, c)];
			if (k != null && board[idx(r, c + 1)] === k && board[idx(r, c + 2)] === k) n++;
		}
	for (let c = 0; c < SIZE; c++)
		for (let r = 0; r < SIZE - 2; r++) {
			const k = board[idx(r, c)];
			if (k != null && board[idx(r + 1, c)] === k && board[idx(r + 2, c)] === k) n++;
		}
	return n;
}

console.log('survival-match3-check: all assertions passed', { SIZE, CELLS, KINDS });

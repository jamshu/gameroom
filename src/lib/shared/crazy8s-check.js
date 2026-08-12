// Runnable check for Crazy Eights. Run: node src/lib/shared/crazy8s-check.js
import assert from 'node:assert';
import {
	initCrazy8s, playCard, drawCard, legalPlays, topCard, crazy8sScores, crazy8sView
} from './crazy8s.js';

// (a) a fresh game deals 7 to each, a non-8 face up, and a matching active suit.
{
	const g = initCrazy8s([10, 20, 30]);
	assert.equal(g.players.length, 3);
	for (const u of g.players) assert.equal(g.hands[u].length, 7);
	assert.equal(g.stock.length, 52 - 3 * 7 - 1, 'the rest is the stock, minus the up-card');
	assert.notEqual(topCard(g).r, 8, 'never start on a wild');
	assert.equal(g.activeSuit, topCard(g).s);
}

// (b) legality — suit OR rank OR any eight; nothing else.
{
	const top = { r: 5, s: 2 }; // 5♥
	const hand = [
		{ r: 5, s: 0 }, // rank match
		{ r: 9, s: 2 }, // suit match
		{ r: 8, s: 3 }, // wild
		{ r: 9, s: 0 } // neither
	];
	const legal = legalPlays(hand, top.s, top.r);
	assert.equal(legal.length, 3);
	assert.ok(!legal.some((c) => c.r === 9 && c.s === 0), 'the mismatch is not playable');
}

// (c) a wild eight requires and applies a named suit.
{
	const g = initCrazy8s([1, 2]);
	// Force a known state: player 1 holds an 8, top is a plain card.
	g.hands[1] = [{ r: 8, s: 0 }, { r: 3, s: 1 }];
	g.discard = [{ r: 4, s: 2 }];
	g.activeSuit = 2;
	g.turnIdx = 0;
	assert.throws(() => playCard(g, 1, { r: 8, s: 0 }), /Name a suit/, 'an 8 with no suit is refused');
	const res = playCard(g, 1, { r: 8, s: 0 }, 3);
	assert.equal(res.won, false);
	assert.equal(g.activeSuit, 3, 'the declared suit is now active');
	assert.equal(g.turnIdx, 1, 'turn passed');
}

// (d) emptying the hand wins outright and freezes the game.
{
	const g = initCrazy8s([1, 2]);
	g.hands[1] = [{ r: 4, s: 2 }];
	g.discard = [{ r: 9, s: 2 }];
	g.activeSuit = 2;
	g.turnIdx = 0;
	const res = playCard(g, 1, { r: 4, s: 2 });
	assert.ok(res.won);
	assert.equal(g.result, 1);
	assert.deepEqual(crazy8sScores(g), { 1: 1, 2: 0 });
	assert.throws(() => drawCard(g, 2), /finished/, 'no moves after a win');
}

// (e) turn + ownership guards.
{
	const g = initCrazy8s([1, 2]);
	assert.throws(() => playCard(g, 2, g.hands[2][0]), /Not your turn/);
	assert.throws(() => playCard(g, 1, { r: 99, s: 9 }), /do not hold/);
}

// (f) drawing passes the turn and grows the hand; the view hides rival hands.
{
	const g = initCrazy8s([1, 2]);
	const before = g.hands[1].length;
	drawCard(g, 1);
	assert.equal(g.hands[1].length, before + 1);
	assert.equal(g.turnIdx, 1);

	const view = crazy8sView(g, 1);
	assert.ok(Array.isArray(view.hands['1']), 'own hand is dealt in full');
	assert.deepEqual(view.hands['2'], { count: g.hands[2].length }, 'rival hand is only a count');
	assert.equal(view.stock, undefined, 'the stock order never leaves the server');
	assert.equal(typeof view.stockCount, 'number');
}

// (g) stock exhaustion reshuffles the discard back in, keeping the top.
{
	const g = initCrazy8s([1, 2]);
	g.stock = [];
	g.discard = [{ r: 2, s: 0 }, { r: 3, s: 1 }, { r: 4, s: 2 }, { r: 5, s: 3 }];
	const top = g.discard[g.discard.length - 1];
	drawCard(g, 1); // player 1 draws → forces a reshuffle
	assert.equal(topCard(g).r, top.r, 'the face-up top is preserved');
	assert.equal(topCard(g).s, top.s);
	assert.ok(g.stock.length >= 2, 'the buried cards came back as stock');
}

console.log('crazy8s-check: all assertions passed');

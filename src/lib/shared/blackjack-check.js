// Runnable check for Blackjack. Run: node src/lib/shared/blackjack-check.js
import assert from 'node:assert';
import {
	initBlackjack, handValue, hit, stand, blackjackScores, blackjackView
} from './blackjack.js';

// (a) hand value — face cards are 10, aces flex from 11 to 1.
{
	assert.equal(handValue([{ r: 13, s: 0 }, { r: 10, s: 1 }]).total, 20);
	assert.equal(handValue([{ r: 14, s: 0 }, { r: 13, s: 1 }]).total, 21, 'ace + king is 21');
	assert.equal(handValue([{ r: 14, s: 0 }, { r: 14, s: 1 }]).total, 12, 'two aces: 11+1');
	const bust = handValue([{ r: 10, s: 0 }, { r: 9, s: 1 }, { r: 5, s: 2 }]);
	assert.ok(bust.bust && bust.total === 24);
	// an ace saves a would-be bust by dropping to 1
	assert.equal(handValue([{ r: 14, s: 0 }, { r: 9, s: 1 }, { r: 5, s: 2 }]).total, 15);
}

// (b) a fresh deal: 2 cards each + a 2-card dealer, rest is stock.
{
	const g = initBlackjack([1, 2]);
	assert.equal(g.hands[1].length, 2);
	assert.equal(g.hands[2].length, 2);
	assert.equal(g.dealer.length, 2);
	assert.equal(g.stock.length, 52 - 2 * 2 - 2);
	assert.equal(g.phase, 'playing');
}

// (c) the hole card is masked until the round is done.
{
	const g = initBlackjack([1]);
	const mid = blackjackView(g, 1);
	assert.equal(mid.dealer.cards.length, 2);
	assert.deepEqual(mid.dealer.cards[1], { hidden: true }, 'hole card hidden mid-round');
	assert.equal(mid.dealer.up, handValue([g.dealer[0]]).total);
}

// (d) turn order + a full round to resolution. Stack the deck deterministically.
{
	const g = initBlackjack([1, 2]);
	// Known hands: p1 20 (stands), p2 12 then will stand low; dealer 18.
	g.hands[1] = [{ r: 13, s: 0 }, { r: 10, s: 1 }]; // 20
	g.hands[2] = [{ r: 5, s: 0 }, { r: 7, s: 1 }]; // 12
	g.dealer = [{ r: 10, s: 2 }, { r: 8, s: 3 }]; // 18, already >=17 so no draw
	g.stock = [{ r: 2, s: 0 }]; // spare, unused

	assert.throws(() => hit(g, 2), /Not your turn/, 'seat order enforced');
	stand(g, 1);
	assert.equal(g.turnIdx, 1, 'passed to seat 2');
	stand(g, 2); // last seat → dealer resolves inside this call
	assert.equal(g.phase, 'done');
	assert.equal(g.outcomes[1], 'win', '20 beats 18');
	assert.equal(g.outcomes[2], 'lose', '12 loses to 18');
	assert.deepEqual(blackjackScores(g), { 1: 1, 2: 0 });
	// after done, the view reveals the full dealer hand and its total
	const done = blackjackView(g, 1);
	assert.equal(done.dealer.total, 18);
	assert.ok(!done.dealer.cards.some((c) => c.hidden));
}

// (e) a bust ends the seat automatically and loses regardless of the dealer.
{
	const g = initBlackjack([1]);
	g.hands[1] = [{ r: 10, s: 0 }, { r: 9, s: 1 }]; // 19
	g.dealer = [{ r: 2, s: 2 }, { r: 3, s: 3 }]; // 5, would bust often
	g.stock = [{ r: 10, s: 0 }, { r: 6, s: 1 }, { r: 5, s: 2 }]; // next hit for p1 busts (19+ top)
	const res = hit(g, 1); // 19 + 5 = 24 bust → seat ends → dealer resolves
	assert.ok(res.bust);
	assert.equal(g.phase, 'done');
	assert.equal(g.outcomes[1], 'lose', 'a bust always loses');
}

// (f) push when totals tie.
{
	const g = initBlackjack([1]);
	g.hands[1] = [{ r: 10, s: 0 }, { r: 8, s: 1 }]; // 18
	g.dealer = [{ r: 10, s: 2 }, { r: 8, s: 3 }]; // 18
	stand(g, 1);
	assert.equal(g.outcomes[1], 'push');
	assert.deepEqual(blackjackScores(g), { 1: 0 }, 'a push scores no point');
}

console.log('blackjack-check: all assertions passed');

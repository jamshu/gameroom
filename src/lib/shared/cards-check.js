// Runnable check for the shared deck. Run: node src/lib/shared/cards-check.js
import assert from 'node:assert';
import { makeDeck, shuffle, seededRng, cardLabel, sameCard, isRed } from './cards.js';

// (a) a deck is 52 distinct cards, 13 per suit.
{
	const deck = makeDeck();
	assert.equal(deck.length, 52);
	const keys = new Set(deck.map((c) => `${c.r}-${c.s}`));
	assert.equal(keys.size, 52, 'every card is unique');
	for (let s = 0; s < 4; s++) {
		assert.equal(deck.filter((c) => c.s === s).length, 13, `suit ${s} has 13`);
	}
	assert.ok(deck.every((c) => c.r >= 2 && c.r <= 14), 'ranks are 2..14');
}

// (b) shuffle is a permutation — it loses no card and adds none.
{
	const deck = makeDeck();
	const before = deck.map(cardLabel).sort().join(',');
	shuffle(deck, seededRng('x'));
	assert.equal(deck.length, 52);
	assert.equal(deck.map(cardLabel).sort().join(','), before, 'shuffle conserves the deck');
}

// (c) a seeded shuffle is deterministic; different seeds differ.
{
	const a = shuffle(makeDeck(), seededRng('same'));
	const b = shuffle(makeDeck(), seededRng('same'));
	assert.deepEqual(a, b, 'same seed deals the same order');
	const c = shuffle(makeDeck(), seededRng('other'));
	assert.notDeepEqual(a, c, 'different seeds deal differently');
}

// (d) labels + colour, as the UI reads them.
{
	assert.equal(cardLabel({ r: 14, s: 3 }), 'A♠');
	assert.equal(cardLabel({ r: 10, s: 0 }), '10♣');
	assert.equal(cardLabel({ r: 12, s: 2 }), 'Q♥');
	assert.ok(isRed(1) && isRed(2) && !isRed(0) && !isRed(3), 'diamonds and hearts are red');
	assert.ok(sameCard({ r: 5, s: 1 }, { r: 5, s: 1 }));
	assert.ok(!sameCard({ r: 5, s: 1 }, { r: 5, s: 2 }));
}

console.log('cards-check: all assertions passed');

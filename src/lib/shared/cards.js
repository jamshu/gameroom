// A 52-card deck, shared by every card game (crazy8s, blackjack, gofish) and by
// their solo pages. Pure and isomorphic — no `$lib`/`$env` — because the rules
// that consume it run inside the Durable Object bundle. See gamelogic.js's note.
//
// A card is { r, s }: rank 2..14 (11=J, 12=Q, 13=K, 14=A) and suit 0..3
// (0=♣, 1=♦, 2=♥, 3=♠). Numbers, not strings, so a hand serializes small and a
// rank/suit compare is a `===` rather than a parse.

export const SUITS = ['♣', '♦', '♥', '♠'];
const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

/** A fresh ordered 52-card deck. Callers shuffle it. */
export function makeDeck() {
	const deck = [];
	for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ r, s });
	return deck;
}

/**
 * Fisher–Yates in place, returning the array. `rng` is an optional () => [0,1)
 * so a solo page can deal deterministically from a seed; the default is crypto,
 * the same source thief-finder's `shuffled` uses, so a server deal is unguessable.
 */
export function shuffle(arr, rng) {
	const next = rng
		? () => rng()
		: (() => {
				// One draw per swap, filled lazily so we don't allocate for a 0-length arr.
				const buf = new Uint32Array(1);
				return () => (crypto.getRandomValues(buf), buf[0] / 2 ** 32);
			})();
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/**
 * A seeded rng for solo deals — mulberry32 off a string seed. Deterministic, so
 * "same seed, same deal" holds on the solo page the way it does for the room deck.
 */
export function seededRng(seed) {
	let a = 0;
	const str = String(seed);
	for (let i = 0; i < str.length; i++) a = (a * 31 + str.charCodeAt(i)) | 0;
	a = a >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const rankLabel = (r) => RANKS[r] ?? String(r);
export const suitGlyph = (s) => SUITS[s] ?? '?';
export const isRed = (s) => s === 1 || s === 2;
export const cardLabel = (c) => (c ? `${rankLabel(c.r)}${suitGlyph(c.s)}` : '');
export const sameCard = (a, b) => !!a && !!b && a.r === b.r && a.s === b.s;

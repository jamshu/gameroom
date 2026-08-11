// Deterministic seeded PRNG. The whole race model rests on this file: sudoku
// deals one puzzle to the room and match-3 deals one board, but neither is
// shipped cell-by-cell — every client rebuilds it locally from the same seed.
// If two players' streams diverge by a single call they are playing different
// games, so this must be exactly reproducible across the Workers runtime, every
// browser, and node (the check scripts).
//
// ISOMORPHIC BY CONTRACT — no `$lib`, no `$env`, no imports at all. Bundled into
// the DO by wrangler, imported by the SvelteKit client, and run bare by node.
// `check:noenv` enforces it.
//
// NOT for anything security-bearing: mulberry32 is a 32-bit state generator
// chosen for reproducibility and speed, and its output is trivially predictable.
// The one secret in either game — the sudoku solution — is withheld by gameView,
// never by the unguessability of a seed.

/**
 * String -> uint32, so a `crypto.randomUUID()` seed can drive a numeric PRNG.
 * xmur3's mixing step; the avalanche matters because our seeds are UUIDs that
 * share long stretches (version nibble, dashes) and a weak hash would map two of
 * them to neighbouring states — visibly similar boards for different games.
 */
export function hashSeed(str) {
	let h = 1779033703 ^ String(str).length;
	for (let i = 0; i < String(str).length; i++) {
		h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	// final avalanche — without it the low bits barely move between similar seeds
	h = Math.imul(h ^ (h >>> 16), 2246822507);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	return (h ^= h >>> 16) >>> 0;
}

/**
 * A fresh generator for `seed`. Returns a function producing floats in [0, 1).
 *
 * Callers get their OWN generator rather than sharing a module-level one: two
 * games can be live in one DO instance, and an interleaved global stream would
 * make each room's board depend on the other's call order.
 */
export function makeRng(seed) {
	let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
	return function next() {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Integer in [0, n). */
export const rngInt = (rng, n) => Math.floor(rng() * n);

/**
 * Fisher-Yates, in place, returning the same array.
 *
 * Descending — the ascending variant is subtly biased and, more to the point
 * here, a different call count. Any change to the number of `rng()` calls made
 * while building a board silently desynchronises clients running the old code
 * from ones running the new, so this implementation is load-bearing as written.
 */
export function shuffle(rng, arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = rngInt(rng, i + 1);
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/** One element of `arr`, uniformly. Undefined for an empty array. */
export const pick = (rng, arr) => arr[rngInt(rng, arr.length)];

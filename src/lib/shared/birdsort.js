// Bird Sort rules: puzzle generation, legal pours, completion and solvability.
//
// ISOMORPHIC BY CONTRACT — relative imports only, no `$lib`/`$env`. Imported by
// shared/gamelogic.js (bundled into the DO by wrangler) AND by the solo page, so
// the race and the offline game run the same rules. `check:noenv` enforces it.
//
// THE GAME: `COLORS` colours of bird, `HEIGHT` of each, poured between
// `COLORS + EMPTY` tubes until every tube is empty or full of one colour. A pour
// takes the whole top run of one colour from a source tube onto a destination
// that is empty, or whose top bird is the same colour, with room to receive it.
//
// Tubes are plain Arrays of Arrays of small ints (bottom-first). Plain Arrays,
// not typed arrays, deliberately: game state is JSON-serialised into Odoo and
// pushed over the socket, and a typed array round-trips as an object silently.
//
// WHO PAYS FOR GENERATION: only the side that deals. `genTubes` shuffles and then
// verifies solvability, so the puzzle is guaranteed solvable and — same seed —
// byte-identical in the DO, every browser and node. It runs ONCE per game.
import { makeRng, shuffle } from './rng.js';

export const HEIGHT = 4; // birds per colour / tube capacity
export const COLORS = 6; // colour kinds, indices 0..COLORS-1
export const EMPTY = 2; // spare empty tubes — the room to manoeuvre
export const TUBES = COLORS + EMPTY;

/** Race safety cap. First to sort wins; on timeout, most sorted wins. */
export const ROUND_MS = 180_000;

/** The finished board — reference and generation fallback. */
export function solvedTubes() {
	const t = [];
	for (let c = 0; c < COLORS; c++) t.push(Array(HEIGHT).fill(c));
	for (let e = 0; e < EMPTY; e++) t.push([]);
	return t;
}

/** Colour and length of a tube's top same-colour run. `color:-1` if empty. */
export function topRun(tube) {
	if (!tube || tube.length === 0) return { color: -1, count: 0 };
	const color = tube[tube.length - 1];
	let count = 1;
	for (let i = tube.length - 2; i >= 0 && tube[i] === color; i--) count++;
	return { color, count };
}

/** May the top run of `from` be poured onto `to`? */
export function moveLegal(tubes, from, to) {
	if (from === to) return false;
	const s = tubes?.[from];
	const d = tubes?.[to];
	if (!s || !d) return false;
	if (s.length === 0) return false; // nothing to pour
	if (d.length >= HEIGHT) return false; // no room
	if (d.length === 0) return true; // empty accepts anything
	return d[d.length - 1] === topRun(s).color; // else colours must match
}

/**
 * Pour the top run of `from` onto `to`, up to whatever fits. Returns a NEW tubes
 * array (inputs untouched) or `null` if the move is illegal.
 */
export function applyMove(tubes, from, to) {
	if (!moveLegal(tubes, from, to)) return null;
	const next = tubes.map((t) => t.slice());
	const s = next[from];
	const d = next[to];
	const { color, count } = topRun(s);
	const n = Math.min(count, HEIGHT - d.length);
	for (let i = 0; i < n; i++) {
		s.pop();
		d.push(color);
	}
	return next;
}

/** Every tube empty or full of a single colour? */
export function isSolved(tubes) {
	for (const t of tubes) {
		if (t.length === 0) continue;
		if (t.length !== HEIGHT) return false;
		for (const b of t) if (b !== t[0]) return false;
	}
	return true;
}

/** How many tubes are a completed single-colour stack — the ticker's metric. */
export function sortedCount(tubes) {
	let n = 0;
	for (const t of tubes) {
		if (t.length !== HEIGHT) continue;
		if (t.every((b) => b === t[0])) n++;
	}
	return n;
}

/** Progress toward the finish: completed tubes out of the `COLORS` needed. */
export function progressOf(tubes) {
	const done = sortedCount(tubes || []);
	return { done, total: COLORS, pct: Math.round((done / COLORS) * 100) };
}

/**
 * A tube-order-independent fingerprint of a state. Sorting the per-tube strings
 * collapses states that differ only by which empty/identical tube holds what —
 * a huge prune for the solver, since swapping two interchangeable tubes is never
 * progress.
 */
const key = (tubes) => tubes.map((t) => t.join(',')).sort().join('|');

/**
 * Is `tubes` solvable? Bounded DFS over legal pours with a visited set.
 *
 * `cap` bounds the pathological case: an UNSOLVABLE board must exhaust its
 * (deduped) reachable states to prove it, so a runaway is capped and reported as
 * unsolvable — `genTubes` simply reshuffles. A solvable board is found long
 * before the cap because DFS dives, so honest generation never hits it.
 */
export function solvable(tubes, cap = 200_000) {
	const seen = new Set();
	const stack = [tubes];
	let nodes = 0;
	while (stack.length) {
		if (++nodes > cap) return false;
		const cur = stack.pop();
		if (isSolved(cur)) return true;
		const k = key(cur);
		if (seen.has(k)) continue;
		seen.add(k);
		for (let f = 0; f < cur.length; f++) {
			for (let t = 0; t < cur.length; t++) {
				const nx = applyMove(cur, f, t);
				if (nx && !seen.has(key(nx))) stack.push(nx);
			}
		}
	}
	return false;
}

/**
 * Deal a solvable puzzle for `seed`. Shuffle all birds into the colour tubes,
 * leave `EMPTY` empty, and accept the first deal that is neither already solved
 * nor unsolvable. Same seed => byte-identical board everywhere, which is what
 * makes the race fair and lets the check assert determinism.
 */
export function genTubes(seed) {
	const rng = makeRng(seed);
	const bag = [];
	for (let c = 0; c < COLORS; c++) for (let i = 0; i < HEIGHT; i++) bag.push(c);

	for (let attempt = 0; attempt < 200; attempt++) {
		const dealt = shuffle(rng, bag.slice());
		const tubes = [];
		for (let c = 0; c < COLORS; c++) tubes.push(dealt.slice(c * HEIGHT, c * HEIGHT + HEIGHT));
		for (let e = 0; e < EMPTY; e++) tubes.push([]);
		if (!isSolved(tubes) && solvable(tubes)) return tubes;
	}
	return solvedTubes(); // never expected; a valid, if trivial, board
}

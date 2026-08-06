// The sequence of board positions a token visits between two states, for the
// cell-by-cell hop animation. Pure (no geometry) so it's testable; the caller
// maps each pos to a grid centre via centreForPos.
//
// Forward move along the track (old→new, both on ring/home 0..55): walk every
// intermediate cell so the token hops square by square. Anything else — entering
// from the yard (-1→0), a capture sending it home (→ -1), or reaching the finish
// (56) — is a single hop, so we return just the endpoint.
export function hopPositions(oldPos, newPos) {
	const forward = newPos > oldPos && oldPos >= 0 && newPos <= 56;
	if (!forward) return [newPos];
	const out = [];
	for (let p = oldPos + 1; p <= newPos; p++) out.push(p);
	return out;
}

// ponytail: self-check — run with `node src/lib/games/ludo-hop.js`. Guard on
// `process`: this module is bundled into the browser/Workers build too, where
// `process` is undefined and touching `process.argv` at import throws (500).
if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
	const eq = (a, b, msg) => {
		if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
	};
	eq(hopPositions(0, 6), [1, 2, 3, 4, 5, 6], 'six-step walk visits each cell');
	eq(hopPositions(-1, 0), [0], 'yard entry is one hop');
	eq(hopPositions(5, -1), [-1], 'capture home is one hop');
	eq(hopPositions(52, 56), [53, 54, 55, 56], 'run into home/finish walks the lane');
	eq(hopPositions(3, 3), [3], 'no move is a single endpoint');
	console.log('ludo-hop ok');
}

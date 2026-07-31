// Assertions for the DO rollout flag. Run: npm run check:doflag
//
// Stickiness is the property worth testing. Per-room rollback only works if a
// room's verdict never changes between two calls — a room that flipped mid-game
// would have state in two places at once.
import assert from 'node:assert';
import { isDoRoom } from './doflag.js';

/* ---- off / unset ---------------------------------------------------------- */
for (const off of [undefined, '', 'off', 'OFF', ' off ', 'false', '0']) {
	assert.strictEqual(isDoRoom(42, off), false, `"${off}" must mean off`);
}
// Unset is the safe default: a missing binding must never silently enable a
// half-built DO path in production.
assert.strictEqual(isDoRoom(1, undefined), false);

/* ---- all ------------------------------------------------------------------ */
for (const all of ['all', 'ALL', ' all ', 'true', '1']) {
	assert.strictEqual(isDoRoom(42, all), true, `"${all}" must mean all`);
}

/* ---- explicit id list ----------------------------------------------------- */
assert.strictEqual(isDoRoom(7, '1,7,42'), true);
assert.strictEqual(isDoRoom(8, '1,7,42'), false);
assert.strictEqual(isDoRoom(7, ' 1 , 7 , 42 '), true, 'whitespace tolerated');
assert.strictEqual(isDoRoom('7', '1,7,42'), true, 'string roomId coerces');
// A room id that merely CONTAINS a listed id must not match.
assert.strictEqual(isDoRoom(70, '7'), false);

/* ---- pct ------------------------------------------------------------------ */
assert.strictEqual(isDoRoom(42, 'pct:0'), false);
assert.strictEqual(isDoRoom(42, 'pct:100'), true);
assert.strictEqual(isDoRoom(42, 'pct:abc'), false, 'garbage must fail closed');

// STICKY: same room, same answer, every time.
for (const id of [1, 7, 42, 158, 160, 99999]) {
	const first = isDoRoom(id, 'pct:20');
	for (let i = 0; i < 50; i++) {
		assert.strictEqual(isDoRoom(id, 'pct:20'), first, `room ${id} flipped — per-room rollback would be incoherent`);
	}
}

// MONOTONIC: a room enabled at pct:N stays enabled at every larger N. Without
// this, widening a rollout would DISABLE some rooms that were already running on
// the DO — silently stranding their state.
for (let id = 1; id <= 400; id++) {
	let enabledAt = null;
	for (let pct = 0; pct <= 100; pct += 10) {
		const on = isDoRoom(id, `pct:${pct}`);
		if (on && enabledAt === null) enabledAt = pct;
		if (enabledAt !== null) assert.ok(on, `room ${id} was on at pct:${enabledAt} but off at pct:${pct}`);
	}
}

// SPREAD: sequential ids must not bucket together. `id % 100` would put rooms
// 1..20 in a 20% rollout and 21..400 out of it — a "sample" of neighbours.
// Assert the enabled set is scattered rather than a leading block.
const on20 = [];
for (let id = 1; id <= 400; id++) if (isDoRoom(id, 'pct:20')) on20.push(id);
assert.ok(on20.length > 400 * 0.1, `pct:20 enabled only ${on20.length}/400 — hash is too narrow`);
assert.ok(on20.length < 400 * 0.35, `pct:20 enabled ${on20.length}/400 — hash is too wide`);
const firstTwenty = on20.filter((id) => id <= 20).length;
assert.ok(firstTwenty < 15, `pct:20 clustered ${firstTwenty}/20 of the lowest ids — not a spread sample`);

console.log(`doflag-check: all assertions passed (pct:20 selected ${on20.length}/400 rooms)`);

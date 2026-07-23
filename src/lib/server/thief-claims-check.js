// Runnable check for the envelope claim resolver — the race-sensitive path.
// Run: node src/lib/server/thief-claims-check.js
import assert from 'node:assert';
import { register } from 'node:module';
register('./thief-env-stub-loader.mjs', import.meta.url);
const { thiefDeal, resolveClaims, filterPickRows } = await import('./gamelogic.js');

const EPOCH = 'game-A';
// `epoch` defaults to the current game so existing cases keep matching; pass a
// different one to model a pick row left over from a PREVIOUS game in the room.
const pick = (uid, envelope, id, epoch = EPOCH) => ({
	id,
	x_studio_sender_uid: uid,
	x_studio_payload: JSON.stringify({ epoch, draw: 1, envelope })
});

// draw 1, phase picking, then force a known envelope layout for deterministic asserts.
function laid(nPlayers, roles) {
	const players = Array.from({ length: nPlayers }, (_, i) => 100 + i);
	const g = { type: 'thief_finder', epoch: EPOCH, players, draw: 0, drawsTotal: 5, phase: 'idle', totals: {} };
	thiefDeal(g);
	g.envelopes = roles;
	g.claims = {};
	g.policeUid = null;
	g.secret = null;
	return g;
}
const LAYOUT = ['Thief', 'Police', 'King']; // envelope idx -> role

// 1. Collision: two players tap envelope 0; earliest id wins, loser holds nothing.
{
	const g = laid(3, LAYOUT);
	resolveClaims(g, [pick(100, 0, 1), pick(101, 0, 2)]);
	assert.equal(g.claims[0], 100, 'earliest pick wins the envelope');
	assert.ok(!Object.values(g.claims).includes(101), 'collision loser holds nothing');
	assert.equal(g.phase, 'picking', 'not everyone has claimed');
}

// 2. Police revealed the moment its envelope (idx 1) is opened, before the set is full.
{
	const g = laid(3, LAYOUT);
	resolveClaims(g, [pick(101, 1, 1)]);
	assert.equal(g.policeUid, 101, 'police announced on open');
}

// 3. All envelopes claimed -> guessing, secret built from the layout.
{
	const g = laid(3, LAYOUT);
	resolveClaims(g, [pick(100, 0, 1), pick(101, 1, 2), pick(102, 2, 3)]);
	assert.equal(g.phase, 'guessing');
	assert.deepEqual(g.secret, { 100: 'Thief', 101: 'Police', 102: 'King' });
	assert.equal(g.policeUid, 101);
}

// 4. Loser re-picks a free envelope later (higher id) -> completes the set.
{
	const g = laid(3, LAYOUT);
	resolveClaims(g, [pick(100, 0, 1), pick(101, 0, 2), pick(102, 2, 3), pick(101, 1, 4)]);
	assert.equal(g.phase, 'guessing');
	assert.deepEqual(g.secret, { 100: 'Thief', 101: 'Police', 102: 'King' });
}

// 5. Determinism: replaying the same log twice yields identical claims (self-heal safety).
{
	const rows = [pick(100, 0, 1), pick(101, 0, 2), pick(102, 2, 3)];
	const a = laid(3, LAYOUT);
	resolveClaims(a, rows);
	const b = laid(3, LAYOUT);
	resolveClaims(b, rows);
	assert.deepEqual(a.claims, b.claims);
}

// 6. Cross-game isolation: a previous game's pick rows (a DIFFERENT epoch, same
//    draw:1) share the room's append-only log after a rematch. filterPickRows
//    must drop them so the fresh game claims nothing until players actually pick.
{
	const g = laid(3, LAYOUT); // g.epoch === EPOCH ('game-A'), draw 1
	const log = [
		pick(100, 0, 1, 'game-OLD'), // leftover from the previous game — must be ignored
		pick(101, 1, 2, 'game-OLD'),
		pick(102, 2, 3, 'game-OLD')
	];
	const rows = filterPickRows(log, g);
	assert.equal(rows.length, 0, 'stale previous-game picks are filtered out');
	resolveClaims(g, rows);
	assert.deepEqual(g.claims, {}, 'no card is auto-assigned in the fresh game');
	assert.equal(g.phase, 'picking', 'fresh game stays in picking until real picks land');
}

// 7. Same log, but the current game's own picks (matching epoch) still resolve,
//    while the stale ones alongside them are ignored.
{
	const g = laid(3, LAYOUT);
	const rows = filterPickRows(
		[pick(999, 0, 1, 'game-OLD'), pick(100, 0, 2), pick(101, 1, 3), pick(102, 2, 4)],
		g
	);
	resolveClaims(g, rows);
	assert.equal(g.phase, 'guessing', 'this game’s picks complete the set');
	assert.deepEqual(g.secret, { 100: 'Thief', 101: 'Police', 102: 'King' });
	assert.ok(!Object.values(g.claims).includes(999), 'the stale picker never claims');
}

console.log('thief-claims-check: all assertions passed');

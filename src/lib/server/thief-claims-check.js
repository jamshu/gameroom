// Runnable check for the envelope claim resolver — the race-sensitive path.
// Run: node src/lib/server/thief-claims-check.js
import assert from 'node:assert';
import { register } from 'node:module';
register('./thief-env-stub-loader.mjs', import.meta.url);
const { thiefDeal, resolveClaims } = await import('./gamelogic.js');

const pick = (uid, envelope, id) => ({
	id,
	x_studio_sender_uid: uid,
	x_studio_payload: JSON.stringify({ draw: 1, envelope })
});

// draw 1, phase picking, then force a known envelope layout for deterministic asserts.
function laid(nPlayers, roles) {
	const players = Array.from({ length: nPlayers }, (_, i) => 100 + i);
	const g = { type: 'thief_finder', players, draw: 0, drawsTotal: 5, phase: 'idle', totals: {} };
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

console.log('thief-claims-check: all assertions passed');

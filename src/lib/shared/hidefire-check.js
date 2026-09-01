// Runnable check for Hide & Fire team-combat round logic.
// Run: node src/lib/shared/hidefire-check.js
import assert from 'node:assert';
import { ROUND_MS, assignTeams, initHideFire, applyHit, resolve, nextRound } from './hidefire.js';

// Teams: even index -> A, odd -> B. Balanced for 2, 4 and 8.
{
	assert.deepEqual(assignTeams([10, 20]), { 10: 'A', 20: 'B' });
	assert.deepEqual(assignTeams([1, 2, 3, 4]), { 1: 'A', 2: 'B', 3: 'A', 4: 'B' });
	const eight = assignTeams([1, 2, 3, 4, 5, 6, 7, 8]);
	assert.equal(Object.values(eight).filter((t) => t === 'A').length, 4, 'four on A');
	assert.equal(Object.values(eight).filter((t) => t === 'B').length, 4, 'four on B');
}

// Friendly fire is rejected; an enemy hit kills; a dead player can't be re-killed.
{
	const g = initHideFire([1, 2, 3, 4], null, 0); // A={1,3}, B={2,4}
	assert.equal(g.phase, 'playing');
	assert.equal(resolve(g, 0), null, 'nothing decided at t=0');

	// 1 (A) shoots 3 (A) -> friendly fire, no kill
	assert.equal(applyHit(g, 3, 1).killed, false, 'no team-kill');
	assert.ok(g.alive[3], 'teammate still alive');
	// a dead player can't shoot
	g.alive[1] = false;
	assert.equal(applyHit(g, 2, 1).killed, false, 'a dead shooter lands nothing');
	g.alive[1] = true;
	// 1 (A) shoots 2 (B) -> kill
	assert.equal(applyHit(g, 2, 1).killed, true);
	// re-killing a corpse does nothing
	assert.equal(applyHit(g, 2, 1).killed, false);
	// hit with no shooter given (legacy path) still kills a live enemy
	assert.equal(applyHit(g, 4).killed, true);
}

// Last team standing: wipe team B -> A wins, +1 to every A member only.
{
	const g = initHideFire([1, 2, 3, 4], null, 0); // A={1,3}, B={2,4}
	applyHit(g, 2, 1);
	assert.equal(resolve(g, 10), null, 'B still has 4 alive');
	applyHit(g, 4, 3);
	assert.equal(resolve(g, 20), 'A', 'B fully wiped');
	assert.equal(g.scores[1], 1, 'A members score');
	assert.equal(g.scores[3], 1);
	assert.equal(g.scores[2], 0, 'B members do not');
	assert.equal(g.scores[4], 0);
	// idempotent + frozen to further hits
	assert.equal(resolve(g, 30), 'A');
	assert.equal(applyHit(g, 1, 2).killed, false, 'finished round takes no hits');
}

// Timeout with both teams alive: more survivors wins.
{
	const g = initHideFire([1, 2, 3, 4], null, 0); // A={1,3}, B={2,4}
	applyHit(g, 2, 1); // B down to 1 (just uid 4)
	assert.equal(resolve(g, ROUND_MS - 1), null, 'not yet');
	assert.equal(resolve(g, ROUND_MS), 'A', 'A: 2 alive vs B: 1');
	assert.equal(g.scores[1], 1);
	assert.equal(g.scores[3], 1);
}

// Timeout with equal survivors is a draw — nobody scores.
{
	const g = initHideFire([1, 2], null, 0); // A={1}, B={2}
	assert.equal(resolve(g, ROUND_MS), 'draw', '1v1, both alive at the cap');
	assert.equal(g.scores[1], 0);
	assert.equal(g.scores[2], 0);
}

// Simultaneous wipe -> draw.
{
	const g = initHideFire([1, 2], null, 0);
	g.alive[1] = false;
	g.alive[2] = false;
	assert.equal(resolve(g, 10), 'draw');
}

// Next round: same teams, carry the score, everyone revived.
{
	const g = initHideFire([1, 2, 3, 4], null, 0);
	applyHit(g, 2, 1);
	applyHit(g, 4, 3);
	resolve(g, 10); // A wins, {1,3} -> 1
	const n = nextRound(g, 1000);
	assert.deepEqual(n.teams, g.teams, 'teams unchanged (deathmatch)');
	assert.equal(n.scores[1], 1, 'score carried');
	assert.equal(n.scores[3], 1);
	assert.equal(n.result, null, 'fresh round');
	assert.equal(n.alive[2], true, 'everyone alive again');
	assert.equal(n.endsAt, 1000 + ROUND_MS);
}

console.log('hidefire-check OK');

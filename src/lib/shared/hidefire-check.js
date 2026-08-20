// Runnable check for Hide & Fire round logic.
// Run: node src/lib/shared/hidefire-check.js
import assert from 'node:assert';
import { ROUND_MS, assignRoles, initHideFire, applyHit, resolve, nextRound } from './hidefire.js';

// Roles: first round splits by index, next round flips.
{
	const r = assignRoles([10, 20]);
	assert.equal(r[10], 'hider');
	assert.equal(r[20], 'seeker');
	const swapped = assignRoles([10, 20], r);
	assert.equal(swapped[10], 'seeker');
	assert.equal(swapped[20], 'hider');
}

// Seeker shooting the hider ends the round for the seekers, +1 to the seeker only.
{
	const g = initHideFire([1, 2], null, 0); // 1 hides, 2 seeks
	assert.equal(g.phase, 'playing');
	assert.equal(resolve(g, 0), null, 'nothing decided at t=0');

	// A seeker cannot be shot.
	assert.equal(applyHit(g, 2).killed, false);
	// The hider can.
	assert.equal(applyHit(g, 1).killed, true);
	// A dead hider cannot be re-killed.
	assert.equal(applyHit(g, 1).killed, false);

	assert.equal(resolve(g, 1000), 'seekers');
	assert.equal(g.scores[2], 1, 'seeker scored');
	assert.equal(g.scores[1], 0, 'hider did not');
	// Idempotent: a second resolve / late hit changes nothing.
	assert.equal(resolve(g, 2000), 'seekers');
	assert.equal(g.scores[2], 1);
	assert.equal(applyHit(g, 1).killed, false, 'finished round takes no hits');
}

// Timer expiring with a hider alive gives the round to the hiders.
{
	const g = initHideFire([1, 2], null, 0);
	assert.equal(resolve(g, ROUND_MS - 1), null, 'not yet');
	assert.equal(resolve(g, ROUND_MS), 'hiders');
	assert.equal(g.scores[1], 1, 'hider scored');
	assert.equal(g.scores[2], 0);
}

// Next round swaps sides and carries the score.
{
	const g = initHideFire([1, 2], null, 0);
	applyHit(g, 1);
	resolve(g, 10); // seekers win, 2 -> 1
	const n = nextRound(g, 1000);
	assert.equal(n.roles[1], 'seeker', 'sides swapped');
	assert.equal(n.roles[2], 'hider');
	assert.equal(n.scores[2], 1, 'score carried');
	assert.equal(n.result, null, 'fresh round');
	assert.equal(n.alive[1], true, 'everyone alive again');
	assert.equal(n.endsAt, 1000 + ROUND_MS);
}

console.log('hidefire-check OK');

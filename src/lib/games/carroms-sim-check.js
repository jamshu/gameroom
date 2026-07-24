// Smallest runnable check for the carrom sim: head-on transfer + pocket capture.
// Run: npm run check:sim
import assert from 'node:assert';
import { simulate, BOARD } from './carroms-sim.js';

// 1. Head-on equal-mass collision transfers momentum (mover stops-ish, target moves on)
{
	const a = { id: 'a', x: 400, y: 500, r: 18, vx: 6, vy: 0, pocketed: false };
	const b = { id: 'b', x: 500, y: 500, r: 18, vx: 0, vy: 0, pocketed: false };
	simulate([a, b]);
	assert(b.x > 550, `target should have been pushed right, got x=${b.x}`);
	assert(a.x < 520, `mover should stop near impact, got x=${a.x}`);
	assert(a.x < b.x - 30, `bodies should have separated, a=${a.x} b=${b.x}`);
}

// 2. A ball aimed at a corner pocket gets captured
{
	const c = { id: 'c', x: 200, y: 200, r: 18, vx: -14, vy: -14, pocketed: false };
	const { pocketed } = simulate([c]);
	assert(c.pocketed && pocketed.includes('c'), 'ball aimed at corner should pocket');
}

// 3. Striker pocket is reported separately
{
	const s = { id: 's', x: 200, y: 200, r: 24, vx: -14, vy: -14, pocketed: false };
	const { strikerPocketed, pocketed } = simulate([s]);
	assert(strikerPocketed && pocketed.length === 0, 'striker pocket flagged, not listed');
}

// 4. Everything comes to rest inside the board
{
	const bodies = Array.from({ length: 5 }, (_, i) => ({
		id: `x${i}`, x: 450 + i * 40, y: 500, r: 18, vx: 25 - i * 3, vy: 5, pocketed: false
	}));
	simulate(bodies);
	for (const b of bodies) {
		if (b.pocketed) continue;
		assert(b.vx === 0 && b.vy === 0, 'all bodies should stop');
		assert(b.x >= b.r && b.x <= BOARD.SIZE - b.r, 'inside walls');
	}
}

// 5. Impacts are reported so the board can sound them. Collision speed drives
//    loudness, so it must be a real closing speed, not a flag.
{
	const a = { id: 'a', x: 400, y: 500, r: 18, vx: 6, vy: 0, pocketed: false };
	const b = { id: 'b', x: 500, y: 500, r: 18, vx: 0, vy: 0, pocketed: false };
	const { events } = simulate([a, b]);
	const hit = events.find((e) => e.type === 'hit');
	assert(hit, 'a head-on collision should report a hit');
	assert(hit.speed > 0, `hit should carry a closing speed, got ${hit.speed}`);
	assert(hit.step >= 0, 'hit should carry the step it happened on');
	assert([hit.id, hit.other].sort().join() === 'a,b', 'hit names both discs');
}

// 6. A pocket is reported for the body that fell in — the board tells a coin,
//    the queen and the striker apart by this id.
{
	const c = { id: 'c', x: 200, y: 200, r: 18, vx: -14, vy: -14, pocketed: false };
	const { events } = simulate([c]);
	assert(events.some((e) => e.type === 'pocket' && e.id === 'c'), 'pocket event for c');
}

// 7. A cushion bounce is reported. Aimed along the wall's normal, well away from
//    the corner pockets so it rebounds rather than being captured.
{
	const w = { id: 'w', x: 500, y: 500, r: 18, vx: 0, vy: -20, pocketed: false };
	const { events } = simulate([w]);
	assert(events.some((e) => e.type === 'wall' && e.id === 'w'), 'wall event for w');
}

// 8. A gentle tap stays silent — below-threshold impacts would only crowd the
//    audio on a break without being audible as distinct hits.
{
	const a = { id: 'a', x: 400, y: 500, r: 18, vx: 2.5, vy: 0, pocketed: false };
	const b = { id: 'b', x: 437, y: 500, r: 18, vx: 0, vy: 0, pocketed: false };
	const { events } = simulate([a, b]);
	assert(!events.some((e) => e.type === 'hit'), 'a nudge should not emit a hit');
}

console.log('carroms-sim: all checks passed');

// Tiny 2D carrom physics: equal-mass circle elastic collisions, wall bounces,
// linear damping, pocket capture at the four corners. Runs only on the
// shooter's client; the settled result is posted to the server.
// ponytail: custom sim, not matter.js — homogeneous discs on a square need ~120
// lines; swap to a real engine only if collision feel proves unacceptable.

export const BOARD = { SIZE: 1000, R: 18, STRIKER_R: 24, POCKET_R: 34 };

const FRICTION = 0.985; // per-step velocity retention
const STOP_V = 2; // below this speed a body is considered stopped
const STEP = 1; // fixed timestep units per integration step
const RESTITUTION = 0.9; // wall bounce energy retention

const POCKETS = [
	{ x: 30, y: 30 },
	{ x: BOARD.SIZE - 30, y: 30 },
	{ x: 30, y: BOARD.SIZE - 30 },
	{ x: BOARD.SIZE - 30, y: BOARD.SIZE - 30 }
];

// Sound thresholds: below these an impact is a nudge nobody would hear, and
// emitting it would only crowd the audio on a hard break.
// Both sit above STOP_V (2): a contact that transfers less than the speed at
// which the sim considers a disc stopped isn't an impact anyone would hear.
const MIN_HIT_V = 3;
const MIN_WALL_V = 3;
const MAX_EVENTS = 200; // a pathological break must not grow this without bound

/**
 * bodies: [{id, x, y, r, vx, vy, pocketed}] — include the striker with id 's'.
 * Mutates bodies. Returns { pocketed: [ids], strikerPocketed, events }.
 * Runs to rest (bounded steps so a bug can't hang the tab).
 *
 * `events` is [{type:'hit'|'wall'|'pocket', step, id, speed}] — everything the
 * caller needs to play a sound at the moment the impact is on screen. The sim
 * stays pure: it reports, it never plays anything.
 */
export function simulate(bodies, onStep = null) {
	const pocketed = [];
	const events = [];
	let strikerPocketed = false;
	const emit = (e) => {
		if (events.length < MAX_EVENTS) events.push(e);
	};

	for (let step = 0; step < 6000; step++) {
		if (onStep && step % 4 === 0) onStep(bodies, step);
		let moving = false;
		for (const b of bodies) {
			if (b.pocketed) continue;
			b.x += b.vx * STEP;
			b.y += b.vy * STEP;
			b.vx *= FRICTION;
			b.vy *= FRICTION;
			if (Math.hypot(b.vx, b.vy) < STOP_V) {
				b.vx = 0;
				b.vy = 0;
			} else {
				moving = true;
			}

			// walls
			const wallV = Math.max(
				b.x < b.r || b.x > BOARD.SIZE - b.r ? Math.abs(b.vx) : 0,
				b.y < b.r || b.y > BOARD.SIZE - b.r ? Math.abs(b.vy) : 0
			);
			if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * RESTITUTION; }
			if (b.x > BOARD.SIZE - b.r) { b.x = BOARD.SIZE - b.r; b.vx = -Math.abs(b.vx) * RESTITUTION; }
			if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * RESTITUTION; }
			if (b.y > BOARD.SIZE - b.r) { b.y = BOARD.SIZE - b.r; b.vy = -Math.abs(b.vy) * RESTITUTION; }
			if (wallV > MIN_WALL_V) emit({ type: 'wall', step, id: b.id, speed: wallV });

			// pockets
			for (const p of POCKETS) {
				if (Math.hypot(b.x - p.x, b.y - p.y) < BOARD.POCKET_R) {
					b.pocketed = true;
					b.vx = 0;
					b.vy = 0;
					if (b.id === 's') strikerPocketed = true;
					else pocketed.push(b.id);
					emit({ type: 'pocket', step, id: b.id, speed: 0 });
					break;
				}
			}
		}

		// pairwise collisions (equal mass elastic; striker slightly heavier ignored)
		for (let i = 0; i < bodies.length; i++) {
			const a = bodies[i];
			if (a.pocketed) continue;
			for (let j = i + 1; j < bodies.length; j++) {
				const c = bodies[j];
				if (c.pocketed) continue;
				const dx = c.x - a.x;
				const dy = c.y - a.y;
				const dist = Math.hypot(dx, dy);
				const minDist = a.r + c.r;
				if (dist === 0 || dist >= minDist) continue;
				const nx = dx / dist;
				const ny = dy / dist;
				// separate overlap
				const overlap = (minDist - dist) / 2;
				a.x -= nx * overlap;
				a.y -= ny * overlap;
				c.x += nx * overlap;
				c.y += ny * overlap;
				// exchange normal velocity components (equal mass)
				const avn = a.vx * nx + a.vy * ny;
				const cvn = c.vx * nx + c.vy * ny;
				const diff = avn - cvn;
				if (diff > 0) {
					a.vx -= diff * nx;
					a.vy -= diff * ny;
					c.vx += diff * nx;
					c.vy += diff * ny;
					moving = true;
					// `diff` is the closing speed along the contact normal — exactly
					// how hard the two discs met, so it maps straight to loudness.
					if (diff > MIN_HIT_V) emit({ type: 'hit', step, id: a.id, other: c.id, speed: diff });
				}
			}
		}

		if (!moving) break;
	}
	return { pocketed, strikerPocketed, events };
}

/** Build sim bodies from game pieces + a striker at (sx, sy) flicked with velocity (vx, vy). */
export function buildBodies(pieces, sx, sy, vx, vy) {
	const bodies = pieces
		.filter((p) => !p.pocketed)
		.map((p) => ({ id: p.id, x: p.x, y: p.y, r: BOARD.R, vx: 0, vy: 0, pocketed: false }));
	bodies.push({ id: 's', x: sx, y: sy, r: BOARD.STRIKER_R, vx, vy, pocketed: false });
	return bodies;
}

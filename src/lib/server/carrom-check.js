// Runnable check for carroms — seating geometry, the shot-replay contract, and
// the server rules. Run: node src/lib/server/carrom-check.js
//
// The three things worth pinning down here, none of which a type checker sees:
//   * every seat's own baseline renders at the BOTTOM of that seat's screen, and
//     the pointer inverse round-trips exactly (otherwise the striker fights the
//     finger on a rotated board);
//   * a client replaying game.lastEvent.shot from the positions it already held
//     lands on the same board the server stored — the whole basis for opponents
//     watching real physics instead of a straight-line slide;
//   * a room that was mid-match when the red coin was removed survives its next
//     shot.
import assert from 'node:assert';
import { register } from 'node:module';
import {
	T_MIN,
	T_MAX,
	sideOfSeat,
	strikerPos,
	alongSide,
	clampT,
	viewRotation,
	toBoard
} from '../games/carrom-seats.js';
import { simulate, buildBodies } from '../games/carroms-sim.js';
register('./thief-env-stub-loader.mjs', import.meta.url);
const { initGame, carromsApplyShot, initialCarromPieces } = await import('./gamelogic.js');

const A = 100, B = 101;
const fresh = (n = 2) => initGame('carroms', n === 2 ? [A, B] : [A, B, 102, 103], {});
const live = (g) => g.pieces.filter((p) => !p.pocketed).map((p) => ({ id: p.id, x: p.x, y: p.y }));
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/** What the canvas paints: translate(C,C) → rotate(theta) → translate(-C,-C). */
function toScreen(p, theta) {
	const C = 500;
	const c = Math.cos(theta), s = Math.sin(theta);
	const dx = p.x - C, dy = p.y - C;
	return { x: C + dx * c - dy * s, y: C + dx * s + dy * c };
}

/* ---------------------------- seating geometry ---------------------------- */

// 1. Partners face each other. Teams are seat parity, so seats 0 and 2 are one
//    team — they must be on OPPOSITE edges, which is why a 2-player game skips a
//    side instead of numbering its seats 0 and 1.
{
	assert.deepEqual([0, 1].map((s) => sideOfSeat(s, 2)), [0, 2], '2 players sit opposite');
	assert.deepEqual([0, 1, 2, 3].map((s) => sideOfSeat(s, 4)), [0, 1, 2, 3], '4 players fill the ring');
	for (const n of [2, 4]) {
		for (let seat = 0; seat + 2 < n; seat++) {
			const mine = sideOfSeat(seat, n);
			const partner = sideOfSeat(seat + 2, n);
			assert.equal((mine + 2) % 4, partner, `seat ${seat} and its partner face each other in a ${n}-player game`);
		}
	}
	assert.equal(sideOfSeat(-1, 4), 0, 'a spectator holds no seat');
}

// 2. Every seat sees its OWN baseline along the bottom edge and its opponent's
//    along the top. This is the whole point of the rotation.
{
	for (const side of [0, 1, 2, 3]) {
		const theta = viewRotation(side);
		const lo = toScreen(strikerPos(side, T_MIN), theta);
		const hi = toScreen(strikerPos(side, T_MAX), theta);
		assert.ok(near(lo.y, 880) && near(hi.y, 880), `side ${side} draws its own baseline at the bottom`);

		const facing = toScreen(strikerPos((side + 2) % 4, 500), theta);
		assert.ok(near(facing.y, 120), `side ${side} sees the opposite baseline at the top`);
	}
	assert.equal(viewRotation(0), 0, 'the bottom seat needs no rotation');
}

// 3. The pointer inverse is exact, and a placement drag tracks the finger on
//    every side — including the two where t runs backwards on screen.
{
	for (const side of [0, 1, 2, 3]) {
		const theta = viewRotation(side);
		const p = { x: 317, y: 642 };
		const back = toBoard(toScreen(p, theta).x, toScreen(p, theta).y, theta);
		assert.ok(near(back.x, p.x, 1e-9) && near(back.y, p.y, 1e-9), `side ${side} round-trips a pointer exactly`);

		// finger at screen x=300 then x=700, both on the baseline
		for (const screenX of [300, 700]) {
			const t = alongSide(side, toBoard(screenX, 880, theta));
			const drawn = toScreen(strikerPos(side, clampT(t)), theta);
			assert.ok(near(drawn.x, screenX), `side ${side}: striker follows the finger to screen x=${screenX}`);
			assert.ok(near(drawn.y, 880), `side ${side}: striker stays on the baseline`);
		}
	}
	assert.equal(clampT(20), T_MIN, 'placement is clamped to the shooting circles');
	assert.equal(clampT(9999), T_MAX);
}

/* -------------------------------- the break -------------------------------- */

// 4. No red coin: 18 coins, nine a side, centre spot empty.
{
	const P = initialCarromPieces();
	assert.equal(P.length, 18, 'eighteen coins');
	assert.ok(!P.some((p) => p.color === 'q'), 'no queen');
	assert.equal(P.filter((p) => p.color === 'w').length, 9, 'nine white');
	assert.equal(P.filter((p) => p.color === 'b').length, 9, 'nine black');
	assert.ok(!P.some((p) => p.x === 500 && p.y === 500), 'centre spot left empty');
	const g = fresh();
	assert.ok(!('coverPending' in g) && !('queenPocketedBy' in g), 'no cover state on a new game');
}

/* ------------------------------ turns & scoring ---------------------------- */

// 5. A dry shot passes the strike; pocketing your own coin keeps it.
{
	const g = fresh();
	const out = carromsApplyShot(g, A, { positions: live(g), shot: { sx: 500, sy: 880, vx: 0, vy: -30 } });
	assert.equal(out.continueTurn, false);
	assert.equal(g.turnIdx, 1, 'a dry shot passes the strike');

	const g2 = fresh();
	const own = g2.pieces.find((p) => p.color === 'w');
	const out2 = carromsApplyShot(g2, A, {
		positions: live(g2).filter((p) => p.id !== own.id),
		pocketed: [own.id],
		shot: { sx: 500, sy: 880, vx: 0, vy: -30 }
	});
	assert.equal(out2.continueTurn, true, 'pocketing your own coin keeps the strike');
	assert.equal(g2.turnIdx, 0);
	assert.equal(g2.scores.w, 1);
}

// 6. Clearing a colour wins outright — there is no queen left to gate it.
{
	const g = fresh();
	const whites = g.pieces.filter((p) => p.color === 'w').map((p) => p.id);
	carromsApplyShot(g, A, {
		positions: live(g).filter((p) => !whites.includes(p.id)),
		pocketed: whites,
		shot: { sx: 500, sy: 880, vx: 0, vy: -30 }
	});
	assert.equal(g.result, 'w', 'clearing white ends the game');
}

// 7. A striker foul returns one of the shooter's coins and passes the strike.
{
	const g = fresh();
	const own = g.pieces.find((p) => p.color === 'w');
	carromsApplyShot(g, A, {
		positions: live(g).filter((p) => p.id !== own.id),
		pocketed: [own.id],
		shot: { sx: 500, sy: 880, vx: 0, vy: -30 }
	});
	const out = carromsApplyShot(g, A, { positions: live(g), strikerPocketed: true, shot: { sx: 500, sy: 880, vx: 0, vy: -30 } });
	assert.equal(out.foul, true);
	assert.equal(g.scores.w, 0, 'the foul gives the point back');
	assert.equal(g.turnIdx, 1, 'a foul passes the strike');
}

// 8. A room already mid-match when the red coin was removed must survive its
//    next shot rather than throwing on a piece the rules no longer know.
{
	const g = fresh();
	g.pieces.unshift({ id: 'q', color: 'q', x: 500, y: 500, pocketed: false });
	g.coverPending = true;
	g.queenPocketedBy = 'w';
	carromsApplyShot(g, A, {
		positions: live(g).filter((p) => p.id !== 'q'),
		pocketed: ['q'], // an un-reloaded client can still report her
		shot: { sx: 500, sy: 880, vx: 0, vy: -30 }
	});
	assert.ok(!g.pieces.some((p) => p.color === 'q'), 'the queen is dropped for good');
	assert.ok(!('coverPending' in g) && !('queenPocketedBy' in g), 'her cover state goes with her');
	assert.equal(g.scores.w + g.scores.b, 0, 'she scores nothing on the way out');
}

/* ------------------------------ shot replay -------------------------------- */

// 9. THE contract for everyone-sees-the-shot: re-running lastEvent.shot from the
//    positions a client already held reproduces the board the server stored.
//    Three shots in sequence, from two different sides, so a replay that started
//    from the wrong edge or the wrong snapshot would show up.
{
	const g = fresh();
	let held = g.pieces.map((p) => ({ ...p })); // what an opponent's client holds

	const shots = [
		{ side: 0, t: 500, vx: 0.6, vy: -34.2 },
		{ side: 2, t: 430, vx: -1.4, vy: 31.7 },
		{ side: 0, t: 610, vx: -8.3, vy: -28.9 }
	];

	for (const [n, s] of shots.entries()) {
		const uid = g.players[g.turnIdx];
		const start = strikerPos(s.side, s.t);
		// the shooter rounds to exactly what the server will broadcast, so the
		// replay starts from the same four numbers this simulation did
		const sx = Math.round(start.x), sy = Math.round(start.y);
		const vx = Math.round(s.vx * 1000) / 1000, vy = Math.round(s.vy * 1000) / 1000;

		const shooter = buildBodies(g.pieces.map((p) => ({ ...p })), sx, sy, vx, vy);
		const shot = simulate(shooter);
		carromsApplyShot(g, uid, {
			positions: shooter.filter((b) => b.id !== 's' && !b.pocketed).map((b) => ({ id: b.id, x: b.x, y: b.y })),
			pocketed: shot.pocketed,
			strikerPocketed: shot.strikerPocketed,
			shot: { sx, sy, vx, vy }
		});

		const ev = g.lastEvent;
		assert.equal(ev.shot.sy, s.side === 0 ? 880 : 120, `shot ${n + 1} starts on the shooter's own baseline`);
		// how a client tells a real shot from a state version bumped by, say, a
		// voice join — see the comment on lastEvent.seq
		assert.equal(ev.seq, n + 1, `shot ${n + 1} carries its own sequence number`);

		// …and now the part every other client runs
		let steps = 0;
		const replay = buildBodies(held.map((p) => ({ ...p })), ev.shot.sx, ev.shot.sy, ev.shot.vx, ev.shot.vy);
		const out = simulate(replay, () => steps++);

		assert.deepEqual(out.pocketed.slice().sort(), shot.pocketed.slice().sort(), `shot ${n + 1}: replay pockets the same coins`);
		assert.equal(out.strikerPocketed, shot.strikerPocketed, `shot ${n + 1}: replay agrees on the striker`);
		for (const p of g.pieces.filter((p) => !p.pocketed)) {
			const b = replay.find((b) => b.id === p.id);
			assert.ok(b && !b.pocketed, `shot ${n + 1}: ${p.id} is still on the replayed board`);
			// the server rounds, so half a unit on a 1000-wide board is the ceiling
			assert.ok(
				Math.abs(b.x - p.x) <= 0.5 && Math.abs(b.y - p.y) <= 0.5,
				`shot ${n + 1}: ${p.id} settles where the server stored it`
			);
		}
		assert.ok(steps > 60, `shot ${n + 1}: the replay lasts long enough to watch (${steps} steps)`);

		held = g.pieces.map((p) => ({ ...p })); // settle onto the authoritative board
	}
}

// 10. A client on an older build posts no `shot`; that must degrade to the
//     straight-line tween, not throw.
{
	const g = fresh();
	carromsApplyShot(g, A, { positions: live(g) });
	assert.equal(g.lastEvent.shot, null, 'no shot payload → nothing to replay');
	assert.equal(g.lastEvent.kind, 'shot');
}

// 11. lastEvent.seq only advances on an actual shot. Everything else that writes
//     room state — a voice join, a member change — bumps the envelope version
//     the client watches, and seq is what stops those replaying the last shot.
{
	const g = fresh();
	carromsApplyShot(g, A, { positions: live(g), shot: { sx: 500, sy: 880, vx: 0, vy: -30 } });
	assert.equal(g.lastEvent.seq, 1);
	carromsApplyShot(g, B, { positions: live(g), shot: { sx: 500, sy: 120, vx: 0, vy: 30 } });
	assert.equal(g.lastEvent.seq, 2, 'the next real shot advances seq by one');
	// carromsApplyShot is the ONLY thing that touches it, so any other write to
	// the room leaves the client looking at a seq it has already shown
	assert.equal(fresh().shotSeq, 0, 'a new game starts the sequence over');
}

console.log('carrom-check: all assertions passed');

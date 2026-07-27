// Runnable check for the seating rule behind the game-type switch.
// Run: node src/lib/games-check.js
//
// This rule is the whole reason a room can change game: roles are otherwise
// assigned once at accept time against the OLD game's capacity, so a five-player
// Thief Finder room switched to chess would keep five `player` rows and `start`
// would reject it forever. Both the server (reseatRoles) and the lobby preview
// go through seatedPlayerIds, so they can't disagree about who keeps a seat.
import assert from 'node:assert';
import { GAMES, GAME_TYPES, gameById, gameLabel, playerCapacity, seatedPlayerIds, contendedProgress, isContendedPhase, outranksAtSameVersion } from './games.js';

const rows = (n, from = 1) =>
	Array.from({ length: n }, (_, i) => ({ id: from + i, accepted: true }));
const seatIds = (...args) => [...seatedPlayerIds(...args)].sort((a, b) => a - b);

// (a) capacities per game — chess 2, carroms/ludo 4, thief falls back to the room cap.
{
	assert.equal(playerCapacity('chess', 8), 2);
	assert.equal(playerCapacity('carroms', 8), 4);
	assert.equal(playerCapacity('ludo', 8), 4);
	assert.equal(playerCapacity('thief_finder', 8), 8, 'thief uses the room max');
	assert.equal(playerCapacity('thief_finder', 0), 10, 'and defaults when unset');
}

// (b) the over-capacity case: 5 thief players -> chess seats the 2 lowest ids.
//     The host is always the first member row, so the host keeps a seat.
{
	assert.deepEqual(seatIds(rows(5), 'chess', 8), [1, 2]);
	assert.deepEqual(seatIds(rows(5), 'ludo', 8), [1, 2, 3, 4]);
	assert.deepEqual(seatIds(rows(5), 'thief_finder', 8), [1, 2, 3, 4, 5], 'all fit');
}

// (c) join order decides, not array order — members arrive from Odoo `order: id asc`
//     but the rule must not depend on that.
{
	const shuffled = [{ id: 9, accepted: true }, { id: 2, accepted: true }, { id: 5, accepted: true }];
	assert.deepEqual(seatIds(shuffled, 'chess', 8), [2, 5]);
}

// (d) non-accepted members never take a seat (pending/left/rejected rows are in
//     the same member list the endpoint receives).
{
	const mixed = [
		{ id: 1, accepted: true }, { id: 2, accepted: false },
		{ id: 3, accepted: true }, { id: 4, accepted: true }
	];
	assert.deepEqual(seatIds(mixed, 'chess', 8), [1, 3], 'id 2 is skipped, not seated');
}

// (e) under-capacity is fine — the primary use case is a 2-player thief lobby
//     switching to chess, where nobody moves at all.
{
	assert.deepEqual(seatIds(rows(2), 'chess', 8), [1, 2]);
	assert.deepEqual(seatIds([], 'chess', 8), []);
}

// (f) the shared game list stays coherent — every id resolves, and an unknown id
//     falls back rather than rendering `undefined` in a chip.
{
	assert.equal(GAME_TYPES.length, GAMES.length);
	for (const id of GAME_TYPES) {
		assert.equal(gameById(id).id, id);
		assert.ok(gameLabel(id).includes(gameById(id).label));
	}
	assert.equal(gameById('poker'), GAMES[0], 'unknown id falls back');
}

/* ------------------- (g) equal-version ordering, contended phase -------------
   Two players opening envelopes at the same instant both persist state.v+1 from
   the same base, so equal versions can carry DIFFERENT claim maps. Both version
   gates (the poll's and the store's mergeState) then fall back on this ranking
   to decide which one is actually later. It has to be a TOTAL order: rank by
   "the content differs" alone and the losing `picking` payload overwrites the
   winning `guessing` one, walking the room backwards. */
{
	const pick = (n) => ({
		type: 'thief_finder',
		phase: 'picking',
		claims: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, 100 + i]))
	});
	// `thiefView` nulls `claims` outside picking — the ranking must survive that
	const guessing = { type: 'thief_finder', phase: 'guessing', claims: null };

	// within picking, a fuller claim map is strictly later (resolveClaims rebuilds
	// from an append-only log, so fuller claims means a fuller log)
	assert.ok(contendedProgress(pick(2)) > contendedProgress(pick(1)));
	assert.equal(contendedProgress(pick(1)), contendedProgress(pick(1)), 'and is stable');

	// the phase step dominates the claim count — a room cannot hold 1000 players,
	// so the guessing flip outranks ANY picking payload, however full
	assert.ok(contendedProgress(guessing) > contendedProgress(pick(999)),
		'guessing can never be walked back to picking at the same version');

	// phases only a single writer can reach opt out entirely: they are reached by
	// the police guess, which bumps the version properly and needs no tiebreak
	for (const phase of ['reveal', 'finished', 'idle']) {
		assert.equal(contendedProgress({ type: 'thief_finder', phase, claims: {} }), null, phase);
	}
	// turn-serialized games never contend, so they keep the strict version rule
	for (const type of ['chess', 'ludo', 'carroms']) {
		assert.equal(contendedProgress({ type, phase: 'picking' }), null, type);
	}
	assert.equal(contendedProgress(null), null, 'no game at all');

	assert.ok(isContendedPhase(pick(0)) && isContendedPhase(guessing));
	assert.ok(!isContendedPhase({ type: 'chess' }), 'the server gate agrees with the ranking');

	/* the tie-break the store's mergeState applies once its strict `<` check has
	   passed. The reported bug IS the false case here: the second of two colliding
	   pushes must still be applied when it is the fuller one. */
	const outranks = outranksAtSameVersion;

	assert.ok(outranks(pick(1), pick(2)), 'the fuller claim map wins, whichever arrived first');
	assert.ok(!outranks(pick(2), pick(1)), 'and the emptier one is still rejected');
	assert.ok(!outranks(pick(2), pick(2)), 'an identical redelivery changes nothing');
	assert.ok(outranks(pick(3), guessing), 'the guessing flip is always later');
	assert.ok(!outranks(guessing, pick(3)), 'and can never be undone by a late picking push');

	// nothing held yet — there is no state to walk backwards over
	assert.ok(outranks(null, pick(1)));
	// a phase the ranking does not cover is strictly later than anything it does,
	// so it must be left alone rather than overwritten
	const reveal = { type: 'thief_finder', phase: 'reveal' };
	assert.ok(!outranks(reveal, pick(3)), 'reveal is not overwritten by a stale pick');
	assert.ok(!outranks(reveal, guessing), 'nor walked back to guessing');
	// turn-serialized games never take this path at all
	assert.ok(!outranks({ type: 'chess' }, { type: 'chess' }), 'chess keeps the strict rule');
}

console.log('games-check: all assertions passed');

// Runnable check for the seating rule behind the game-type switch.
// Run: node src/lib/games-check.js
//
// This rule is the whole reason a room can change game: roles are otherwise
// assigned once at accept time against the OLD game's capacity, so a five-player
// Thief Finder room switched to chess would keep five `player` rows and `start`
// would reject it forever. Both the server (reseatRoles) and the lobby preview
// go through seatedPlayerIds, so they can't disagree about who keeps a seat.
import assert from 'node:assert';
import { GAMES, GAME_TYPES, gameById, gameLabel, playerCapacity, seatedPlayerIds } from './games.js';

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

console.log('games-check: all assertions passed');

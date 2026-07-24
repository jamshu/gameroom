// Runnable check for the server-side seat/round helpers behind the game-type
// switch. Run: node --import ./src/lib/server/room-stub-loader.mjs src/lib/server/room-check.js
//   (or: npm run check:room)
//
// The Playwright specs mock the game-type endpoint, so this is the only thing
// that runs reseatRoles/resetRound for real. It asserts the exact Odoo writes
// they issue AND that they mutate the in-hand member rows — the endpoint echoes
// those rows straight back via publicMembers, so if the mutation were dropped the
// acting host would see stale roles until their next poll.
import assert from 'node:assert';
import { register } from 'node:module';
register('./room-stub-loader.mjs', import.meta.url);
const { reseatRoles, resetRound } = await import('./room.js');

const member = (id, role, status = 'accepted') => ({
	id,
	x_studio_role: role,
	x_studio_status: status,
	x_studio_user_id: [100 + id, `P${id}`]
});
const writesTo = (role) =>
	globalThis.__odooCalls.filter(
		(c) => c.method === 'write' && c.args[1]?.x_studio_role === role
	);

// 1. Over capacity: 5 thief players → chess seats the 2 lowest ids, demotes the
//    other 3. One write per target role; the seated two need no write.
{
	globalThis.__odooCalls.length = 0;
	const members = [1, 2, 3, 4, 5].map((id) => member(id, 'player'));
	const res = await reseatRoles(members, 'chess', 8);

	assert.deepEqual(res, { promoted: 0, demoted: 3 });
	const specWrites = writesTo('spectator');
	assert.equal(specWrites.length, 1, 'one batched demotion write');
	assert.deepEqual(specWrites[0].args[0], [3, 4, 5], 'the 3 highest ids demoted');
	assert.equal(writesTo('player').length, 0, 'already-seated players not rewritten');
	// in-hand rows updated so a following publicMembers is accurate
	assert.deepEqual(members.map((m) => m.x_studio_role), ['player', 'player', 'spectator', 'spectator', 'spectator']);
}

// 2. Promotion (the reverse case): 2 players + 3 spectators → thief promotes all
//    three back. Thief capacity falls back to the room max (8 here).
{
	globalThis.__odooCalls.length = 0;
	const members = [
		member(1, 'player'), member(2, 'player'),
		member(3, 'spectator'), member(4, 'spectator'), member(5, 'spectator')
	];
	const res = await reseatRoles(members, 'thief_finder', 8);

	assert.deepEqual(res, { promoted: 3, demoted: 0 });
	assert.deepEqual(writesTo('player')[0].args[0], [3, 4, 5], 'the 3 spectators promoted');
	assert.equal(writesTo('spectator').length, 0);
	assert.ok(members.every((m) => m.x_studio_role === 'player'));
}

// 3. Under capacity is a no-op: a 2-player thief lobby → chess moves nobody.
//    (the primary use case — the group just wants a game they CAN start.)
{
	globalThis.__odooCalls.length = 0;
	const members = [member(1, 'player'), member(2, 'player')];
	const res = await reseatRoles(members, 'chess', 8);

	assert.deepEqual(res, { promoted: 0, demoted: 0 });
	assert.equal(globalThis.__odooCalls.length, 0, 'no writes when seating is already correct');
}

// 4. Non-accepted rows never take a seat, and pending/left members are ignored
//    entirely (not demoted, not counted).
{
	globalThis.__odooCalls.length = 0;
	const members = [
		member(1, 'player'), member(2, 'player', 'pending'),
		member(3, 'player'), member(4, 'player')
	];
	const res = await reseatRoles(members, 'chess', 8);

	assert.deepEqual(res, { promoted: 0, demoted: 1 }, 'only accepted id 3,4 considered; id 4 demoted');
	assert.deepEqual(writesTo('spectator')[0].args[0], [4]);
	assert.equal(members[1].x_studio_role, 'player', 'the pending row is left untouched');
}

// 5. resetRound: scores → 0 for accepted members, and a finished chess game arms
//    the colour swap (last game's black plays white next) before dropping game.
{
	globalThis.__odooCalls.length = 0;
	const members = [member(1, 'player'), member(2, 'player'), member(3, 'player', 'left')];
	const state = { v: 3, game: { type: 'chess', players: { w: 100, b: 101 } } };
	await resetRound(state, members);

	const scoreWrite = globalThis.__odooCalls.find((c) => c.args[1]?.x_studio_score === 0);
	assert.deepEqual(scoreWrite.args[0], [1, 2], 'only accepted members zeroed');
	assert.equal(state.nextWhiteUid, 101, 'chess colour swap armed to last black');
	assert.equal(state.game, null, 'game dropped');
}

// 6. resetRound on a non-chess game arms no swap flag.
{
	globalThis.__odooCalls.length = 0;
	const state = { v: 2, game: { type: 'ludo', players: [100, 101] } };
	await resetRound(state, [member(1, 'player')]);
	assert.ok(!('nextWhiteUid' in state), 'no colour swap for non-chess');
	assert.equal(state.game, null);
}

console.log('room-check: all assertions passed');

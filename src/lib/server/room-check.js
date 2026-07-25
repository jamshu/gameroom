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
const { reseatRoles, resetRound, createRoomMedia, readRoomMedia, deleteRoom, pickSuccessorHost, finishRoom, publicMembers } =
	await import('./room.js');

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
	// in-hand rows too — rematch pushes these straight to the room, so a row left
	// holding last round's score would broadcast a scoreboard that no longer exists
	assert.deepEqual(members.map((m) => m.x_studio_score), [0, 0, undefined], 'accepted rows zeroed in hand');
}

// 6. resetRound on a non-chess game arms no swap flag.
{
	globalThis.__odooCalls.length = 0;
	const state = { v: 2, game: { type: 'ludo', players: [100, 101] } };
	await resetRound(state, [member(1, 'player')]);
	assert.ok(!('nextWhiteUid' in state), 'no colour swap for non-chess');
	assert.equal(state.game, null);
}

// 7. readRoomMedia is the ownership boundary for chat attachments: the id in the
//    URL addresses every attachment the admin key can read, so anything not
//    tagged with THIS room must come back as null (the route 404s on that).
{
	globalThis.__odooCalls.length = 0;
	const att = (res_model, res_id) => [{ id: 7, res_model, res_id, mimetype: 'image/jpeg', raw: 'AA==' }];

	globalThis.__odooResults = [att('x_gameroom', 42)];
	assert.ok(await readRoomMedia(42, 7), 'own-room attachment is served');

	globalThis.__odooResults = [att('x_gameroom', 43)];
	assert.equal(await readRoomMedia(42, 7), null, 'another room’s attachment is refused');

	globalThis.__odooResults = [att('res.partner', 42)];
	assert.equal(await readRoomMedia(42, 7), null, 'a non-room attachment is refused');

	globalThis.__odooResults = [[]];
	assert.equal(await readRoomMedia(42, 999), null, 'a missing attachment is refused');

	globalThis.__odooCalls.length = 0;
	assert.equal(await readRoomMedia(42, 'abc'), null, 'a non-numeric id never reaches Odoo');
	assert.equal(globalThis.__odooCalls.length, 0);
}

// 7b. Bytes go in `raw`. `datas` does NOT exist on this Odoo and writing it is
//     accepted silently — you get an attachment with file_size 0 and no bytes,
//     which only shows up as a broken image much later. Pin the field name.
{
	globalThis.__odooCalls.length = 0;
	globalThis.__odooResults = [];
	await createRoomMedia(42, { name: 'photo', mime: 'image/jpeg', dataBase64: 'AA==' });
	const vals = globalThis.__odooCalls[0].args[0];
	assert.equal(vals.raw, 'AA==', 'bytes written to raw');
	assert.ok(!('datas' in vals), 'never datas');
	assert.equal(vals.res_model, 'x_gameroom');
	assert.equal(vals.res_id, 42, 'tagged with the room, which is what both guards key on');
}

// 8. deleteRoom unlinks the room's chat media too — this is the whole retention
//    story (last member out, and the abandoned-room sweep, both route here).
{
	globalThis.__odooCalls.length = 0;
	// one entry per call, in order: search+unlink for media, events, members, then
	// the room unlink
	globalThis.__odooResults = [[5, 6], true, [11], true, [21], true, true];
	await deleteRoom(42);

	const unlinks = globalThis.__odooCalls.filter((c) => c.method === 'unlink');
	assert.deepEqual(
		unlinks.map((c) => c.model),
		['ir.attachment', 'x_room_event', 'x_room_member', 'x_gameroom'],
		'media unlinked before the rows that reference the room'
	);
	assert.deepEqual(unlinks[0].args[0], [5, 6], 'the searched attachment ids are the ones unlinked');
	const search = globalThis.__odooCalls.find((c) => c.model === 'ir.attachment' && c.method === 'search');
	assert.deepEqual(
		search.args[0],
		[['res_model', '=', 'x_gameroom'], ['res_id', '=', 42]],
		'scoped to this room only'
	);
}

// 9. Host succession: the room outlives whoever made it. Longest-standing
//    ACCEPTED member takes over (member ids ascend with join order, same rule
//    reseatRoles uses), never a pending/left row and never the person leaving.
{
	const m = (id, status = 'accepted') => ({
		id, x_studio_status: status, x_studio_user_id: [100 + id, `P${id}`]
	});

	assert.equal(pickSuccessorHost([m(1), m(2), m(3)], 101), 102, 'next-oldest accepted takes over');
	assert.equal(
		pickSuccessorHost([m(3), m(2), m(1)], 101), 102,
		'ordering is by member id, not array position'
	);
	assert.equal(
		pickSuccessorHost([m(1), m(2, 'pending'), m(3)], 101), 103,
		'a pending member never inherits the room'
	);
	assert.equal(
		pickSuccessorHost([m(1), m(2, 'left')], 101), null,
		'nobody accepted left → null, and the caller deletes the room'
	);
	assert.equal(pickSuccessorHost([m(1)], 101), null, 'the leaver is never their own successor');
}

// 9. finishRoom is the single place every game ends through, so it is the only
//    place that can announce the result. Without the roster push the flip to
//    `finished` and the final scores live on rows no other push carries, and the
//    rest of the room sits on a live-looking board until their next poll.
{
	globalThis.__odooCalls.length = 0;
	globalThis.__pushedRosters.length = 0;
	const members = [member(1, 'player'), member(2, 'player')];
	const room = { id: 42, x_name: 'R', x_studio_status: 'playing', x_studio_host_id: [101, 'P1'] };
	await finishRoom(42, members, { 101: 3, 102: 7 }, room);

	assert.equal(globalThis.__pushedRosters.length, 1, 'the room is told exactly once');
	const [push] = globalThis.__pushedRosters;
	assert.equal(push.room.status, 'finished', 'the pushed room row is the post-write one');
	assert.deepEqual(push.members.map((m) => m.score), [3, 7], 'final scores ride along');
	assert.ok(push.members.every((m) => m.role === 'player'), 'seating role, never a game secret');
}

// 9b. …but stays silent without a room row. The eight callers predate the push,
//     so a missed one must degrade to the old poll-driven behaviour, not throw.
{
	globalThis.__odooCalls.length = 0;
	globalThis.__pushedRosters.length = 0;
	await finishRoom(42, [member(1, 'player')], { 101: 1 });
	assert.equal(globalThis.__pushedRosters.length, 0, 'no room row → no push');
	assert.ok(
		globalThis.__odooCalls.some((c) => c.args[1]?.x_studio_status === 'finished'),
		'the write still happens'
	);
}

// 10. The presence window and the poll cadence are three numbers in three files
//     that have to agree: PRESENCE_WINDOW_MS here, PUSH_SAFETY_MS + HIDDEN_MS in
//     stores/room.js, HEARTBEAT_AFTER_MS in the poll route. Get it wrong and a
//     client polling exactly as designed renders offline to everyone else — a
//     bug that looks like a network fault, not a constant. Pin the boundary.
{
	const seenAgo = (ms) =>
		new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
	const at = (ms) => publicMembers([{ ...member(1, 'player'), x_studio_last_seen: seenAgo(ms) }])[0];

	// slowest cadence a LIVE client can be on is the 60s push safety net
	assert.ok(at(65000).online, 'a client on the 60s push safety poll must read online');
	// …and a struggling one is FASTER than that, not slower: the error path used
	// to multiply whichever tier applied (IDLE_MS 10s × a cap of 8 = 80s, and 60s
	// × 2 while push was connected — a two-minute frozen board). It now has its
	// own ladder capped at ERROR_MAX_MS 15s, so failures no longer push anyone
	// near this window. Kept as headroom, not as the binding case.
	assert.ok(at(81000).online, 'a retrying client must still read online');
	// but genuinely gone is still gone
	assert.ok(!at(120000).online, 'two minutes silent is offline');
	assert.ok(!publicMembers([member(1, 'player')])[0].online, 'never seen is offline');
}

console.log('room-check: all assertions passed');

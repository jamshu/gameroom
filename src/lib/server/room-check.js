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
const { reseatRoles, setRoles, resetRound, createRoomMedia, readRoomMedia, deleteRoom, pickSuccessorHost, finishRoom, publicMembers, browseDomain, seatOnAccept, dropMember, writeState, appendEvent, roomSnapshot, syncVoiceSince } =
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

// 4b. setRoles is the MANUAL counterpart to reseatRoles — the host seating one
//     person by hand. The whole reason it exists separately is this case: id 3 is
//     the highest, so a reseatRoles recompute would put it straight back to
//     spectator. Promotion into a free seat moves exactly one row.
{
	globalThis.__odooCalls.length = 0;
	const members = [member(1, 'player'), member(2, 'spectator'), member(3, 'spectator')];
	const res = await setRoles(members, [{ id: 3, role: 'player' }]);

	assert.deepEqual(res, { promoted: 1, demoted: 0 });
	assert.deepEqual(writesTo('player')[0].args[0], [3], 'only the named member promoted');
	assert.equal(writesTo('spectator').length, 0, 'nobody else is touched');
	assert.deepEqual(members.map((m) => m.x_studio_role), ['player', 'spectator', 'player']);
}

// 4c. The swap the lobby's picker posts: promote + demote in one call. Batched
//     per target role, same write shape as reseatRoles, both rows updated in hand
//     so the roster push that follows shows the finished seating.
{
	globalThis.__odooCalls.length = 0;
	const members = [member(1, 'player'), member(2, 'player'), member(3, 'spectator')];
	const res = await setRoles(members, [{ id: 3, role: 'player' }, { id: 2, role: 'spectator' }]);

	assert.deepEqual(res, { promoted: 1, demoted: 1 });
	assert.equal(globalThis.__odooCalls.length, 2, 'one write per target role, not one per member');
	assert.deepEqual(writesTo('player')[0].args[0], [3]);
	assert.deepEqual(writesTo('spectator')[0].args[0], [2]);
	assert.deepEqual(members.map((m) => m.x_studio_role), ['player', 'spectator', 'player']);
}

// 4d. Idempotent, and non-accepted rows are never seated: the endpoint answers a
//     no-op with the current rows, so a stale double-click must not write.
{
	globalThis.__odooCalls.length = 0;
	const members = [member(1, 'player'), member(2, 'spectator', 'pending'), member(3, 'spectator')];
	const res = await setRoles(members, [
		{ id: 1, role: 'player' }, // already seated
		{ id: 2, role: 'player' }, // pending — not a member yet
		{ id: 9, role: 'player' } // no such row
	]);

	assert.deepEqual(res, { promoted: 0, demoted: 0 });
	assert.equal(globalThis.__odooCalls.length, 0, 'nothing to change → no Odoo write at all');
	assert.equal(members[1].x_studio_role, 'spectator', 'the pending row is left untouched');
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

// 11. browseDomain decides who sees which room, so the shape of its OR group is
//     the whole private-room feature. Two things it must get right:
//     (a) the public side is `!= 'private'`, NOT `= 'public'` — every room that
//         existed before the field did has NULL there, and `= 'public'` would
//         make the entire back catalogue vanish from browse;
//     (b) the OR is a trailing prefix group, so Odoo reads it as
//         `(filters) AND (public OR I'm-listed)` rather than OR-ing the filters.
{
	const plain = browseDomain({ uid: 7 });
	assert.deepEqual(plain, [
		['x_studio_status', '!=', 'finished'],
		'|',
		['x_studio_visibility', '!=', 'private'],
		['x_studio_allowed_user_ids', 'in', [7]]
	]);

	const filtered = browseDomain({ uid: 7, q: 'chess night', type: 'chess', status: 'lobby' });
	assert.deepEqual(filtered.slice(0, 4), [
		['x_studio_status', '!=', 'finished'],
		['x_name', 'ilike', 'chess night'],
		['x_studio_game_type', '=', 'chess'],
		['x_studio_status', '=', 'lobby']
	], 'the AND filters stay ahead of the OR group');
	assert.equal(filtered[4], '|', 'the OR operator is the LAST thing pushed');
	assert.equal(filtered.length, 7);

	// junk from the query string never reaches the domain
	assert.equal(browseDomain({ uid: 7, type: 'nope', status: 'finished' }).length, 4,
		'unknown type and a non-browsable status are dropped');
}

// 12. seatOnAccept is shared by the host's Accept button and by a private room's
//     auto-join, so a private room must seat people exactly as a public one does.
{
	const room = (over = {}) => ({
		x_studio_game_type: 'chess', x_studio_max_players: 8, x_studio_status: 'lobby', ...over
	});
	const one = [member(1, 'player')];
	const two = [member(1, 'player'), member(2, 'player')];

	assert.equal(seatOnAccept(room(), one), 'player', 'a free chess seat');
	assert.equal(seatOnAccept(room(), two), 'spectator', 'chess seats exactly 2');
	assert.equal(seatOnAccept(room({ x_studio_status: 'playing' }), one), 'spectator',
		'nobody takes a seat mid-game — game.players is frozen at start');
	assert.equal(seatOnAccept(room({ x_studio_game_type: 'ludo' }), two), 'player', 'ludo seats 4');
	assert.equal(seatOnAccept(room(), [member(1, 'player'), member(2, 'player', 'left')]), 'player',
		'a departed row does not hold a seat');
}

// 13. dropMember: one way out of a room, shared by the host's Remove and by
//     un-inviting someone from a private room. If those two diverged you'd get a
//     member who is off the guest list but still sitting in the room.
{
	globalThis.__odooCalls.length = 0;
	const target = member(2, 'player');
	const state = { v: 1, voice: [101, 102, 103], banned: [104] };
	const uid = await dropMember(target, state);

	assert.equal(uid, 102, 'returns the uid it dropped');
	const write = globalThis.__odooCalls.find((c) => c.method === 'write');
	assert.deepEqual(write.args, [[2], { x_studio_status: 'left' }], "'left', never 'rejected'");
	assert.deepEqual(state.voice, [101, 103], 'pulled out of the call');
	assert.deepEqual(state.banned, [104, 102], 'marked removed-by-host, existing entries kept');
	assert.equal(target.x_studio_status, 'left', 'in-hand row updated for the roster push');

	// idempotent on the marker — a second removal must not double up
	await dropMember(target, state);
	assert.deepEqual(state.banned, [104, 102]);

	// a kick that leaves two people still talking must not stop their clock
	assert.ok(state.voiceSince, 'two left in the call — it is still running');
}

// The call clock. A call is two people, so one person sitting in voice is waiting
// rather than talking, and the stamp must survive a third person arriving.
{
	const s = { voice: [] };
	assert.equal(syncVoiceSince(s).voiceSince, null, 'nobody in voice');

	s.voice = [101];
	assert.equal(syncVoiceSince(s).voiceSince, null, 'one person is not a call');

	s.voice = [101, 102];
	const started = syncVoiceSince(s).voiceSince;
	assert.ok(started > 0, 'the second join starts the clock');

	s.voice = [101, 102, 103];
	assert.equal(syncVoiceSince(s).voiceSince, started,
		'a third person joining must NOT restart a call already in progress');

	s.voice = [103];
	assert.equal(syncVoiceSince(s).voiceSince, null, 'dropping under two ends it');

	s.voice = [103, 104];
	assert.ok(syncVoiceSince(s).voiceSince >= started, 'and a fresh call starts a fresh clock');
}

// 14. writeState's version guard. Two players opening envelopes at the same
//     instant both read the same `state.v` — the pick route then spends two more
//     Odoo round trips (appendEvent, the pick-log read) before writing, so
//     without the guard both persist and publish the SAME v with different claim
//     maps. The client's `state.v <= gv` gate drops whichever arrived second and
//     the poll's `state.v > gv` gate can never re-send it: the board is stuck.
{
	globalThis.__odooCalls.length = 0;
	// what the row actually holds now — another player's pick landed while we were
	// still computing ours
	globalThis.__odooResults = [[{ x_studio_state: JSON.stringify({ v: 9 }) }]];
	const state = { v: 5, game: { type: 'thief_finder' } }; // our stale base
	await writeState(7, state, {}, { guardVersion: true });

	assert.equal(state.v, 10, 'bumped past the row, not past our stale base');
	const read = globalThis.__odooCalls.find((c) => c.method === 'read');
	assert.deepEqual(read.kw.fields, ['x_studio_state'], 'only the field it needs');
	const write = globalThis.__odooCalls.find((c) => c.method === 'write');
	assert.equal(JSON.parse(write.args[1].x_studio_state).v, 10, 'and persists that version');
}

// 15. The guard is opt-in: every other route is turn-serialized, and the extra
//     read is paid against an Odoo budget the whole room shares.
{
	globalThis.__odooCalls.length = 0;
	globalThis.__odooResults = [];
	const state = { v: 5 };
	await writeState(7, state);

	assert.equal(state.v, 6, 'plain increment');
	assert.equal(globalThis.__odooCalls.filter((c) => c.method === 'read').length, 0,
		'no read-back when unguarded');
}

// 16. A guard that finds the row BEHIND us must not rewind. (Reads can be served
//     stale — the row snapshot has a TTL — and a version that went backwards is
//     the very failure this whole mechanism exists to prevent.)
{
	globalThis.__odooCalls.length = 0;
	globalThis.__odooResults = [[{ x_studio_state: JSON.stringify({ v: 2 }) }]];
	const state = { v: 5 };
	await writeState(7, state, {}, { guardVersion: true });

	assert.equal(state.v, 6, 'ours still wins when the row is behind');
}

// 17. stillValid: the OTHER meaning of a concurrent write. Two `thief/deal`
//     calls both read `phase: 'reveal'`, both clear that guard, and both write a
//     different envelope→role shuffle — so ordering them (guardVersion) would
//     only make the room agree on whichever landed last. The second deal must be
//     refused outright, or it reshuffles a draw already under way.
//
//     The precondition deal passes is the DRAW, which is what discriminates a
//     rival deal from any other write.
const dealStillValid = (baseDraw) => ({
	stillValid: (fresh) => (fresh?.game?.draw ?? baseDraw) === baseDraw
});
{
	globalThis.__odooCalls.length = 0;
	// a rival deal already advanced the draw
	globalThis.__odooResults = [[{ x_studio_state: JSON.stringify({ v: 6, game: { draw: 3 } }) }]];
	const state = { v: 5, game: { type: 'thief_finder', draw: 3 } };

	await assert.rejects(
		() => writeState(7, state, {}, dealStillValid(2)),
		(e) => e.status === 409 && e.code === 'conflict',
		'a precondition that broke under us is a coded 409, not a silent overwrite'
	);
	assert.equal(globalThis.__odooCalls.filter((c) => c.method === 'write').length, 0,
		'and nothing was written');
}

// 18. …but a write that did NOT touch the game must not cost the host their
//     deal. Someone toggling their mic bumps the version; the draw is untouched,
//     so this has to go through. Testing the version instead would reject it.
{
	globalThis.__odooCalls.length = 0;
	globalThis.__odooResults = [
		[{ x_studio_state: JSON.stringify({ v: 9, game: { draw: 2 }, voice: [101] }) }]
	];
	const state = { v: 5, game: { type: 'thief_finder', draw: 3 } };
	await writeState(7, state, {}, dealStillValid(2));

	assert.equal(state.v, 10, 'still lands above the row it read');
	assert.equal(globalThis.__odooCalls.filter((c) => c.method === 'write').length, 1,
		'an unrelated write is not a conflict');
}

// 19. writeState drops the room snapshot, same as pushRoster. Polls read through
//     that cache, so without this the reconcile poll a failed write fires is
//     served the PRE-write row, finds nothing new, and the board sits stale until
//     the 60s safety net comes round.
{
	// one snapshot fetch = getRoom's read, then getMembers' search_read
	const queueFetch = (v) => {
		globalThis.__odooResults = [[{ id: 8, x_studio_state: JSON.stringify({ v }) }], []];
	};
	queueFetch(1);
	const before = await roomSnapshot(8);
	globalThis.__odooResults = [];
	assert.strictEqual(await roomSnapshot(8), before, 'cached within the TTL');

	await writeState(8, { v: 1 });
	queueFetch(2);
	const after = await roomSnapshot(8);
	assert.notStrictEqual(after, before, 'writeState invalidated it — refetched, not the TTL');
	assert.equal(JSON.parse(after[0].x_studio_state).v, 2, 'and the poll now sees the new row');
}

/* ==========================================================================
   M2.4 — state ownership moves into the room Durable Object.

   These drive the SEAM rather than the routes: writeState and appendEvent are
   where ~25 call sites funnel through, so proving the dispatch here proves it
   for all of them. `__doResults` queues the object's replies; `__doOps` records
   what was actually sent (see room-stub-loader.mjs).
   ========================================================================== */
const asDoRoom = (id) => { process.env.DO_ROOMS = String(id); };
const noDoRooms = () => { delete process.env.DO_ROOMS; };
const resetDo = () => { globalThis.__doOps = []; globalThis.__doResults = []; globalThis.__odooCalls.length = 0; globalThis.__odooResults = []; };

// 20. The write goes to the object, and NOT to Odoo. This is the milestone in
//     one assertion: a move costs zero Odoo round trips.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: true, state: { v: 12, game: { type: 'chess' } } }];
	const state = { v: 5, game: { type: 'chess' } };
	const out = await writeState(71, state);

	assert.equal(globalThis.__doOps.length, 1, 'one op');
	assert.equal(globalThis.__doOps[0].op, 'setState', 'and it is the authoritative write');
	assert.equal(globalThis.__odooCalls.length, 0, 'Odoo is not touched at all on a move');
	assert.equal(state.v, 12, 'the object bumped the version; the caller sees ITS number');
	assert.strictEqual(out, state, 'and still gets the same object back, as ~24 callers expect');
}

// 21. guardVersion is DROPPED, not translated. Its job was to collapse a
//     read-modify-write window; a single-threaded object has no such window, so
//     emulating it would buy a guarantee we already hold at the price of a round
//     trip on the app's hottest contended route.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: true, state: { v: 8 } }];
	await writeState(71, { v: 5 }, {}, { guardVersion: true });
	assert.equal(globalThis.__doOps.length, 1, 'no extra read to re-derive what setState already does');
	assert.equal(globalThis.__doOps[0].expectV, undefined, 'and no compare-and-set either');
}

// 22. extraVals are x_gameroom COLUMNS — status, host, draws. Only the state
//     blob moved into the object; the room registry stays in Odoo, so these must
//     still be written or `start` would never flip a room to `playing`.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: true, state: { v: 2 } }];
	await writeState(71, { v: 1 }, { x_studio_status: 'playing' });

	const write = globalThis.__odooCalls.find((c) => c.method === 'write');
	assert.equal(write.args[1].x_studio_status, 'playing', 'room columns still reach Odoo');
	assert.equal(write.args[1].x_studio_state, undefined, 'but the state blob does NOT — one writer');
}

// 23. stillValid survives, because it asks a different question: "my
//     precondition broke, do not write at all". It is evaluated against the
//     object's current state, and the version it saw rides along as expectV so
//     the object refuses a write whose verdict has gone stale. That CLOSES the
//     window rather than narrowing it.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: true, owns: true, state: { v: 6, game: { draw: 2 } } }];
	globalThis.__doResults.push({ ok: true, state: { v: 7 } });
	await writeState(71, { v: 5, game: { draw: 3 } }, {}, dealStillValid(2));

	assert.deepEqual(globalThis.__doOps.map((o) => o.op), ['snapshot', 'setState'], 'read, then write');
	assert.equal(globalThis.__doOps[1].expectV, 6, 'carrying the version the predicate judged');
}
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: true, owns: true, state: { v: 6, game: { draw: 3 } } }];
	await assert.rejects(
		() => writeState(71, { v: 5, game: { draw: 3 } }, {}, dealStillValid(2)),
		(e) => e.status === 409 && e.code === 'conflict',
		'a rival deal is still refused outright'
	);
	assert.equal(globalThis.__doOps.length, 1, 'and no write was attempted');
}
{
	// The FIRST guarded write of a room's life must not carry expectV. setState
	// runs the ownership transfer, which replaces the object's state from a fresh
	// Odoo read — so a version snapshotted from a pre-transfer copy (possibly a
	// dropped push, and therefore behind) would meet a different one and reject a
	// deal nobody raced, as "Someone else just changed this".
	asDoRoom(71); resetDo();
	globalThis.__doResults = [
		{ ok: true, owns: false, state: { v: 6, game: { draw: 2 } } },
		{ ok: true, state: { v: 9 } }
	];
	await writeState(71, { v: 5, game: { draw: 3 } }, {}, dealStillValid(2));
	assert.equal(globalThis.__doOps[1].expectV, undefined,
		'no compare-and-set against a copy that is about to be replaced');
}
{
	// …and the object gets the last word: if the state moved between the snapshot
	// and the write, the predicate's verdict is stale and the write is refused.
	asDoRoom(71); resetDo();
	globalThis.__doResults = [
		{ ok: true, owns: true, state: { v: 6, game: { draw: 2 } } },
		{ ok: false, status: 409, code: 'conflict', error: 'Someone else just changed this — try again' }
	];
	await assert.rejects(
		() => writeState(71, { v: 5, game: { draw: 3 } }, {}, dealStillValid(2)),
		(e) => e.status === 409 && e.code === 'conflict',
		'the compare-and-set failing surfaces as the same coded 409'
	);
}

// 24. THE SPLIT-BRAIN GUARD, and the most important assertion in this file. An
//     object that does not answer may still OWN the room's state. Falling back to
//     Odoo there would give the room two writers and corrupt it silently, so the
//     request has to fail instead. Fail closed, never fall back.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = []; // the object did not answer
	await assert.rejects(
		() => writeState(71, { v: 5 }),
		(e) => e.status === 503 && e.code === 'do_unreachable',
		'an unreachable object fails the write'
	);
	assert.equal(globalThis.__odooCalls.filter((c) => c.method === 'write').length, 0,
		'and above all does NOT write Odoo behind an object that may own the state');
}

// 25. Evacuation is the ONE case where the Odoo path is correct again: the object
//     flushed everything it held and refuses further ops. This is what makes the
//     M2.4 rollback a rollback rather than a data-loss button.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: false, error: 'evacuated' }];
	const state = { v: 5 };
	await writeState(71, state);

	assert.equal(state.v, 6, 'the Odoo path bumped it');
	const write = globalThis.__odooCalls.find((c) => c.method === 'write');
	assert.equal(JSON.parse(write.args[1].x_studio_state).v, 6, 'and persisted the state itself');
}

// 26. appendEvent mints inside the object: no Odoo create for a chat message or
//     a WebRTC signal, and no publishEvent either — applyEvent already fanned the
//     event out before it replied, so publishing would deliver every message twice.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: true, id: 4211 }];
	const id = await appendEvent(71, 'chat', { text: 'hi' }, 101);

	assert.equal(id, 4211, 'the id comes from the object');
	assert.equal(globalThis.__doOps[0].op, 'append');
	assert.equal(globalThis.__odooCalls.filter((c) => c.method === 'create').length, 0,
		'and costs no Odoo create');
}
{
	// Same fail-closed rule as writeState: an unreachable object may own the log.
	asDoRoom(71); resetDo();
	await assert.rejects(
		() => appendEvent(71, 'chat', { text: 'hi' }, 101),
		(e) => e.status === 503,
		'an unreachable object fails the append'
	);
	assert.equal(globalThis.__odooCalls.filter((c) => c.method === 'create').length, 0,
		'rather than writing an event Odoo would then hand back under a different id');
}
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: false, error: 'evacuated' }];
	await appendEvent(71, 'chat', { text: 'hi' }, 101);
	assert.equal(globalThis.__odooCalls.filter((c) => c.method === 'create').length, 1,
		'but an evacuated room goes back to creating the Odoo row');
}

// 27. A room the flag does not select is completely untouched by any of this —
//     which is what makes `DO_ROOMS` a real rollout control rather than a switch
//     that has already been thrown.
{
	asDoRoom(71); resetDo();
	const state = { v: 5 };
	await writeState(72, state); // a DIFFERENT room
	assert.equal(globalThis.__doOps.length, 0, 'no op for a room outside the flag');
	assert.equal(state.v, 6, 'the Odoo path, exactly as before');
}
// 28. Removing someone closes their socket. `banned` makes their NEXT handshake
//     terminal, but a socket issues no new requests — so without the kick they
//     keep receiving every state and roster frame for the room they were just
//     thrown out of.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: true }];
	const target = { id: 3, x_studio_status: 'accepted', x_studio_user_id: [303, 'P3'] };
	const state = { voice: [303, 404] };
	await dropMember(target, state, 71);

	const kick = globalThis.__doOps.find((o) => o.op === 'kick');
	assert.ok(kick, 'a removal reaches the object');
	assert.equal(kick.uid, 303, 'and names the player it removed');
	assert.ok(!state.voice.includes(303), 'still dropped from voice, as before');
	assert.ok(state.banned.includes(303), 'and still marked removed-by-host');
}
// 29. Deleting a room must tell the object BEFORE Odoo's rows go, or it is left
//     write-behinding a room that no longer exists — and flush() re-arms on
//     failure, so that is one doomed Odoo call every 15s forever, per dead room,
//     against the budget this whole milestone exists to get off.
{
	asDoRoom(71); resetDo();
	globalThis.__doResults = [{ ok: true }];
	await deleteRoom(71);

	assert.equal(globalThis.__doOps[0]?.op, 'destroy', 'the object is told first');
	// Ordering is the point: every Odoo unlink must come after it.
	assert.ok(globalThis.__odooCalls.length > 0, 'and the Odoo rows still go');
	assert.ok(
		globalThis.__odooCalls.some((c) => c.method === 'unlink' && c.model === 'x_gameroom'),
		'including the room row itself'
	);
}
noDoRooms();

console.log('room-check: all assertions passed (incl. DO dispatch, fail-closed and evacuation)');

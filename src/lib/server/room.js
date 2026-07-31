// Room-level authorization + state helpers. Identity comes from the user's
// session cookie (requireUser); all Odoo I/O for room data uses the admin key —
// players' own Odoo access is read-only, and the secret-bearing state field is
// admin-group-only, so the proxy is the single write path by construction.
import { adminExecute } from './odoo.js';
import { requireUser } from './auth.js';
import { createSnapshotCache } from './roomcache.js';
import { publishState, publishEvent, publishRoster } from './realtime.js';

// The game list is shared with the client so a select, a capacity preview and a
// validation check can't drift. Re-exported here because every server caller
// already imports from this module.
// imported (not just re-exported) because browseDomain and seatOnAccept below
// call them — `export … from` creates no local binding.
import { seatedPlayerIds, GAME_TYPES, playerCapacity } from '../games.js';
export { GAME_TYPES, playerCapacity };

// Latest known member uids per room, refreshed on every member read (getMembers).
// Lets writeState address per-uid push channels without an extra Odoo lookup; a
// just-joined player missing here for one poll cycle is fine (safety poll covers).
const roomUids = new Map();

export const ROOM = 'x_gameroom';
export const MEMBER = 'x_room_member';
export const EVENT = 'x_room_event';
// Chat media (photos, voice clips) lives in Odoo's own attachment model, tagged
// with the room it belongs to. That tag is what makes both the ownership check
// below and the cascade delete in deleteRoom possible.
export const ATTACH = 'ir.attachment';

/**
 * `code` is a stable machine-readable reason the client can branch on. A bare
 * 403 tells a client nothing — it can't distinguish "the host removed you"
 * (stop polling, go home) from a transient failure (keep trying).
 */
export function httpError(status, message, code) {
	const e = new Error(message);
	e.status = status;
	if (code) e.code = code;
	return e;
}

export async function getRoom(roomId) {
	const [room] = await adminExecute(ROOM, 'read', [[Number(roomId)]], {
		fields: ['x_name', 'x_studio_game_type', 'x_studio_status', 'x_studio_host_id',
			'x_studio_max_players', 'x_studio_draws_total', 'x_studio_state',
			// every private-room gate reads these off the row getRoom returns; leave
			// them out and `isPrivate` is silently false everywhere
			'x_studio_visibility', 'x_studio_allowed_user_ids']
	});
	if (!room) throw httpError(404, 'Room not found');
	return room;
}

export async function getMembers(roomId) {
	const members = await adminExecute(MEMBER, 'search_read', [
		[['x_studio_room_id', '=', Number(roomId)]],
		['x_name', 'x_studio_user_id', 'x_studio_status', 'x_studio_role', 'x_studio_score', 'x_studio_last_seen']
	], { order: 'id asc' });
	roomUids.set(Number(roomId), members.map((m) => m.x_studio_user_id?.[0]).filter(Boolean));
	return members;
}

/**
 * Auth + accepted membership. Returns { uid, room, member, members }.
 *
 * The two reads are independent given `uid` (and `requireUser` does no I/O in
 * the normal path), so they go out together — this is on the hot path of every
 * poll. Kept as one `Promise.all` on purpose: if the room is gone, `getRoom`
 * rejecting should win over the 403 an empty member list would produce.
 */
export async function requireMember(cookies, roomId) {
	const { uid } = await requireUser(cookies);
	const [room, members] = await Promise.all([getRoom(roomId), getMembers(roomId)]);
	return { uid, room, member: judgeMembership(uid, room, members), members };
}

/**
 * Accepted-membership verdict, shared by the fresh and cached auth paths so they
 * can't drift. Returns the caller's member row or throws a coded 403 — only some
 * of the codes mean "stop polling forever".
 */
function judgeMembership(uid, room, members) {
	const mine = members.find((m) => m.x_studio_user_id?.[0] === uid);
	if (!mine || mine.x_studio_status !== 'accepted') {
		// `banned` marks "removed by the host", not a permanent ban: it is what makes
		// this 403 terminal AND accurate, so the removed player's poll stops and they
		// land on the room list with the real reason rather than a generic
		// "not a member". Requesting to join again clears the marker (see `join`).
		if ((parseState(room)?.banned || []).includes(uid)) {
			throw httpError(403, 'The host removed you from this room', 'removed');
		}
		if (mine?.x_studio_status === 'pending') {
			throw httpError(403, 'Your join request is still pending', 'pending');
		}
		throw httpError(403, 'You are not a member of this room', 'not_member');
	}
	return mine;
}

// Per-room (room+members) snapshot cache: every client's poll reads the SAME
// two rows, so collapse them to one Odoo fetch per room per short window.
const ROOM_SNAPSHOT_TTL_MS = 750;
const roomCache = createSnapshotCache(
	(id) => Promise.all([getRoom(id), getMembers(id)]),
	ROOM_SNAPSHOT_TTL_MS
);

/** Cached [room, members]. `fresh` bypasses the cache (used for 403 re-judge). */
export function roomSnapshot(roomId, opts) {
	return roomCache.get(Number(roomId), opts);
}

/**
 * Read-only poll variant of requireMember, served from the room snapshot cache.
 * A stale cache could wrongly reject a just-joined/removed player, and the store
 * treats `not_member` as terminal — so any 403 is re-judged against a FRESH
 * snapshot before it's thrown. The happy path (accepted member) never re-fetches.
 */
export async function requireMemberCached(cookies, roomId) {
	const { uid } = await requireUser(cookies);
	let [room, members] = await roomSnapshot(roomId);
	try {
		return { uid, room, member: judgeMembership(uid, room, members), members };
	} catch (e) {
		if (e.status !== 403) throw e;
		[room, members] = await roomSnapshot(roomId, { fresh: true });
		return { uid, room, member: judgeMembership(uid, room, members), members };
	}
}

/** Auth + host of the room. */
export async function requireHost(cookies, roomId) {
	const ctx = await requireMember(cookies, roomId);
	if (ctx.room.x_studio_host_id?.[0] !== ctx.uid) throw httpError(403, 'Host only');
	return ctx;
}

export function parseState(room) {
	try {
		return JSON.parse(room.x_studio_state || 'null') || null;
	} catch {
		return null;
	}
}

/**
 * Bump the state version and persist. `extraVals` folds other x_gameroom fields
 * (e.g. status) into the SAME write — start/rematch used to write this record
 * twice in a row.
 *
 * This is a read-modify-write with no CAS: the base `v` came from a read at the
 * top of the request, and two writers that read the same base both publish v+1
 * with DIFFERENT content — whereupon the client's `state.v <= gv` gate silently
 * drops the second, and the poll's `state.v > gv` gate can never repair it (see
 * stores/room.js mergeState). Both options below close that by re-reading the
 * row's CURRENT version immediately before writing, which collapses the window
 * from the whole request to one round trip. They differ in what a concurrent
 * write MEANS:
 *
 * - `guardVersion` — contention is legitimate and expected (everyone opens an
 *   envelope at once), so just order it: land above whatever is there and let
 *   the later writer win. Correct because the content is rebuilt from an
 *   append-only log (resolveClaims), so the later writer saw the fuller log.
 * - `stillValid(freshState)` — contention means the action should not happen AT
 *   ALL (a second deal would reshuffle the envelopes under a round already in
 *   flight). Re-checks the caller's precondition against the row as it is NOW
 *   and throws a coded 409 instead of writing.
 *
 *   A predicate rather than an expected version on purpose: "the version moved"
 *   is not the same question as "my precondition broke". Someone toggling their
 *   mic bumps the version without touching the game, and rejecting the host's
 *   deal for that would be a bug of its own.
 *
 * Both are off by default because the extra read is charged against a shared
 * ~1 req/s Odoo budget (see the note at the top of this file). Turn-serialized
 * routes — chess, ludo, carroms — need neither.
 */
export async function writeState(roomId, state, extraVals = {}, { guardVersion = false, stillValid } = {}) {
	if (guardVersion || stillValid) {
		const [row] = await adminExecute(ROOM, 'read', [[Number(roomId)]], {
			fields: ['x_studio_state']
		});
		const fresh = parseState(row);
		if (stillValid && !stillValid(fresh)) {
			throw httpError(409, 'Someone else just changed this — try again', 'conflict');
		}
		const rowV = fresh?.v || 0;
		if (rowV > (state.v || 0)) state.v = rowV;
	}
	state.v = (state.v || 0) + 1;
	await adminExecute(ROOM, 'write', [
		[Number(roomId)],
		{ ...extraVals, x_studio_state: JSON.stringify(state) }
	]);
	// Drop the snapshot the polls read through, same as pushRoster does and for
	// the same reason: a poll issued inside the remaining 750ms TTL is served the
	// PRE-write row, so the reconcile poll a failed write fires (store.post's
	// catch) would find no new state and wait out the 60s safety net before
	// trying again. `extraVals` writes room columns too, so the rows are stale
	// either way.
	roomCache.invalidate(Number(roomId));
	// Push the filtered new state straight to each member — no client poll needed.
	//
	// `roomUids` is warm by the time any mutation gets here, but only by
	// coincidence: every auth path runs getMembers() — requireMember directly,
	// requireMemberCached through the snapshot cache, whose loader is
	// Promise.all([getRoom, getMembers]) — and the map has no TTL, so a cache HIT
	// implies a miss already filled it in this process. Nothing enforces that.
	//
	// Re-read rather than push to nobody if it ever stops holding. An empty list
	// makes publishState return early, which is SILENT: no error, no log, and
	// every other player sits out the 60s push safety net before seeing the move.
	// One extra Odoo read on a path that should never run beats that failure mode.
	// The re-read is best-effort like the publish it feeds: it must never turn a
	// successful write into a failed request. The state is already persisted by
	// this point, so the worst case is the pre-existing one — clients fall back to
	// the safety poll.
	let uids = roomUids.get(Number(roomId));
	if (!uids?.length) {
		console.warn(`[realtime] roomUids cold for room ${roomId} — re-reading members before publish`);
		try {
			await getMembers(roomId); // repopulates roomUids as a side effect
			uids = roomUids.get(Number(roomId)) || [];
		} catch (e) {
			console.error(`[realtime] member re-read failed for room ${roomId}:`, e?.message);
			uids = [];
		}
	}
	await publishState(roomId, state, uids);
	return state;
}

/**
 * Store one chat attachment against a room. Returns its id — the chat event
 * carries only that id, never the bytes (an Ably message caps at 64KiB and the
 * poll refetches up to 200 payloads at a time).
 */
export async function createRoomMedia(roomId, { name, mime, dataBase64 }) {
	return adminExecute(ATTACH, 'create', [{
		name: name || 'chat-media',
		mimetype: mime,
		// `raw`, NOT `datas`: the latter doesn't exist on this Odoo, and writing it
		// is accepted silently — you get an attachment with file_size 0 and no
		// bytes. JSON-RPC carries binary fields base64-encoded, so the string goes
		// in and comes back out unchanged.
		raw: dataBase64,
		res_model: ROOM,
		res_id: Number(roomId)
	}]);
}

/**
 * Read one of a room's attachments, or null.
 *
 * The room check is the security boundary, NOT the caller's membership: the id
 * space here is every attachment the admin key can read — other rooms' media
 * and unrelated Odoo records — so an id that isn't tagged with THIS room must
 * be indistinguishable from one that doesn't exist.
 */
export async function readRoomMedia(roomId, attId) {
	const id = Number(attId);
	if (!Number.isInteger(id) || id <= 0) return null;
	const [att] = await adminExecute(ATTACH, 'read', [[id]], {
		fields: ['res_model', 'res_id', 'mimetype', 'raw']
	});
	if (!att || att.res_model !== ROOM || att.res_id !== Number(roomId)) return null;
	return att;
}

export async function appendEvent(roomId, type, payload, senderUid, targetUid = null) {
	const vals = {
		x_name: type,
		x_studio_room_id: Number(roomId),
		x_studio_type: type,
		x_studio_payload: JSON.stringify(payload ?? {}),
		x_studio_sender_uid: senderUid || 0
	};
	if (targetUid) vals.x_studio_target_uid = targetUid;
	const id = await adminExecute(EVENT, 'create', [vals]);
	// push the event itself — public on the room channel, targeted to one user
	await publishEvent(roomId, { id, type, senderUid: senderUid || 0, payload: payload ?? {} }, targetUid);
	return id;
}

/**
 * How stale `last_seen` may get before a member renders offline.
 *
 * Coupled to the poll: it must exceed the slowest cadence a live client can be
 * on, or someone polling exactly as designed would show as offline. The ceiling
 * is the push safety net (60s) and a hidden tab (45s), both in stores/room.js,
 * plus jitter — 90s clears them with room to spare. Widening this is what let
 * the poll slow down; the cost is that the lobby dot is now coarse, going dark
 * up to ~90s after someone actually leaves.
 */
const PRESENCE_WINDOW_MS = 90000;

/** Members serialized for clients (uid-keyed, presence derived). */
export function publicMembers(members) {
	const now = Date.now();
	return members
		.filter((m) => m.x_studio_status !== 'rejected')
		.map((m) => ({
			id: m.id,
			uid: m.x_studio_user_id?.[0],
			name: m.x_studio_user_id?.[1] || m.x_name,
			status: m.x_studio_status,
			role: m.x_studio_role,
			score: m.x_studio_score || 0,
			online:
				m.x_studio_last_seen &&
				now - new Date(m.x_studio_last_seen.replace(' ', 'T') + 'Z').getTime() < PRESENCE_WINDOW_MS
		}));
}

/** Uids of members currently online (last_seen within the presence window). */
export function onlineUids(members) {
	const now = Date.now();
	const set = new Set();
	for (const m of members) {
		const ls = m.x_studio_last_seen;
		if (ls && now - new Date(ls.replace(' ', 'T') + 'Z').getTime() < PRESENCE_WINDOW_MS) {
			set.add(m.x_studio_user_id?.[0]);
		}
	}
	return set;
}

/**
 * Drop voice-roster members who have gone offline — closed the tab, crashed, or
 * navigated away without the (best-effort) leave beacon landing. Returns true if
 * it removed anyone; the caller persists via writeState so the cleaned roster
 * reaches the room. The polling member always counts as online (it just
 * heartbeated), so this never prunes the caller itself.
 */
export function pruneStaleVoice(state, members) {
	if (!state?.voice?.length) return false;
	const live = onlineUids(members);
	const kept = state.voice.filter((u) => live.has(u));
	if (kept.length === state.voice.length) return false;
	state.voice = kept;
	syncVoiceSince(state);
	return true;
}

/**
 * Serialize and push the two rows every client renders. Call this after ANY
 * write that changes them — the Ably push otherwise carries only state and
 * events, so a role change, a join approval, a host handover or a room status
 * flip would reach the rest of the room no sooner than their next poll.
 *
 * Deliberately takes the rows the caller already holds rather than re-reading:
 * they have just been mutated, and the room snapshot cache has a 750ms TTL and
 * NO invalidation, so a re-read here could publish the pre-write rows. Callers
 * that mutate must keep their in-hand rows in step (reseatRoles and finishRoom
 * both do) — that is what makes this accurate without another Odoo round trip.
 */
export function pushRoster(roomId, room, members) {
	// Drop this room from the snapshot cache first. Polls read through it, and a
	// poll issued inside the remaining TTL would be served the PRE-write rows —
	// landing after this push and silently undoing it. That used to self-correct
	// on the next poll seconds later; with the safety net now at 60s it would not.
	roomCache.invalidate(Number(roomId));
	return publishRoster(roomId, { room: publicRoom(room), members: publicMembers(members) });
}

/** Room serialized for clients — never includes raw state. */
export function publicRoom(room) {
	return {
		id: room.id,
		name: room.x_name,
		gameType: room.x_studio_game_type,
		status: room.x_studio_status,
		hostUid: room.x_studio_host_id?.[0],
		hostName: room.x_studio_host_id?.[1],
		maxPlayers: room.x_studio_max_players,
		drawsTotal: room.x_studio_draws_total,
		// the 🔒 chip. The allowed-uid list is deliberately NOT here: this ships on
		// every roster push and poll, and turning uids into names costs an extra
		// res.users read. The host fetches the guest list from `invites` instead.
		visibility: isPrivate(room) ? 'private' : 'public'
	};
}

/* ---------------------------- private rooms -------------------------------
   A room is private only when it says so. x_studio_visibility is NULL on every
   row created before the field existed, so "not private" is the safe reading of
   anything else — never test for 'public'. */

export const isPrivate = (room) => room.x_studio_visibility === 'private';

/** Who may see and auto-join. A many2many reads back as a bare id array — there
 *  is no [id, name] tuple to lean on the way every many2one in this app does. */
export const allowedUids = (room) => room.x_studio_allowed_user_ids || [];

/** Replace the guest list. `[[6, 0, ids]]` is Odoo's "set exactly these". */
export const setAllowed = (roomId, uids) =>
	adminExecute(ROOM, 'write', [
		[Number(roomId)],
		{ x_studio_allowed_user_ids: [[6, 0, [...new Set(uids.map(Number))]]] }
	]);

/**
 * The browse-list domain, as a pure function so the OR group can be asserted
 * without a live Odoo.
 *
 * Odoo domains are prefix notation with an implicit `&` between complete terms,
 * so a trailing `'|', A, B` reads as `(everything before) AND (A OR B)`.
 */
export function browseDomain({ uid, q, type, status }) {
	const domain = [['x_studio_status', '!=', 'finished']];
	if (q) domain.push(['x_name', 'ilike', q]);
	if (GAME_TYPES.includes(type)) domain.push(['x_studio_game_type', '=', type]);
	if (BROWSE_STATUSES.includes(status)) domain.push(['x_studio_status', '=', status]);
	// a private room exists only for the people on its list
	domain.push('|', ['x_studio_visibility', '!=', 'private'], ['x_studio_allowed_user_ids', 'in', [uid]]);
	return domain;
}

export const BROWSE_STATUSES = ['lobby', 'playing'];

/**
 * The role a member takes the moment they're accepted — by the host approving a
 * request, or by auto-join walking into a private room. Both paths must agree or
 * a private room would seat people the public one wouldn't.
 */
export function seatOnAccept(room, members) {
	const playersNow = members.filter(
		(m) => m.x_studio_status === 'accepted' && m.x_studio_role === 'player'
	).length;
	const capacity = playerCapacityFor(room);
	return room.x_studio_status === 'lobby' && playersNow < capacity ? 'player' : 'spectator';
}

const playerCapacityFor = (room) =>
	playerCapacity(room.x_studio_game_type, room.x_studio_max_players);

/**
 * Take one member out of a room: row → 'left', dropped from voice, marked as
 * removed-by-host. Mutates `state` and the caller's in-hand row; the caller
 * persists the state and pushes the roster.
 *
 * Shared by the host's Remove and by striking someone off a private room's guest
 * list, because those two must have identical effects — a difference between
 * them is how you get a member who is out of the list but still in the room.
 */
/**
 * Keep the call-start stamp in step with the voice roster.
 *
 * A call only exists once there are two people in it, so the clock starts on the
 * SECOND join and clears when the roster drops back under two — one person sitting
 * in voice is waiting, not talking. Only writes the stamp when it is absent, so a
 * third person joining does not restart a call already in progress.
 *
 * Lives here rather than beside stateView because gamelogic.js already imports
 * from this module, and the reverse import would close a cycle. stateView needs
 * only the field, not the function.
 *
 * Call from EVERY site that touches state.voice — voice join/leave, leaving the
 * room, and being removed by the host. One helper is what stops those drifting.
 */
export function syncVoiceSince(state) {
	if (!state) return state;
	const live = (state.voice || []).length >= 2;
	if (live) state.voiceSince = state.voiceSince || Date.now();
	else state.voiceSince = null;
	return state;
}

export async function dropMember(target, state) {
	// 'left', not 'rejected': publicMembers filters `rejected` out entirely, which
	// would retroactively degrade their name to `#uid` across chat history.
	await adminExecute(MEMBER, 'write', [[target.id], { x_studio_status: 'left' }]);
	const targetUid = target.x_studio_user_id?.[0];
	// drop them from voice so the remaining peers tear the connection down
	// (mesh.sync already prunes anyone absent from the roster)
	state.voice = (state.voice || []).filter((u) => u !== targetUid);
	syncVoiceSince(state); // a kick can leave one person alone — that ends the call
	// Marks them as removed-by-the-host rather than merely gone, which is what
	// gives their in-flight poll a terminal 403 carrying the real reason instead
	// of a bare "not a member". NOT a ban: `join` clears this marker. For a private
	// room the guest list is the actual gate; this only supplies the message.
	state.banned = [...new Set([...(state.banned || []), targetUid])];
	target.x_studio_status = 'left';
	return targetUid;
}

/**
 * Re-seat roles against a game's capacity, by join order (lowest member id
 * first, so the host — always the first row — keeps their seat).
 *
 * Roles are otherwise only ever assigned at accept time, so without this a room
 * that changes game type keeps the OLD game's seating and can never start:
 * five thief-finder players all stay `player` and chess rejects them.
 *
 * At most two Odoo writes: one per target role, skipping anyone already correct.
 */
export async function reseatRoles(members, gameType, maxPlayers) {
	const accepted = members.filter((m) => m.x_studio_status === 'accepted');
	const seated = seatedPlayerIds(
		accepted.map((m) => ({ id: m.id, accepted: true })),
		gameType,
		maxPlayers
	);

	const toPlayer = accepted.filter((m) => seated.has(m.id) && m.x_studio_role !== 'player');
	const toSpectator = accepted.filter((m) => !seated.has(m.id) && m.x_studio_role !== 'spectator');
	await Promise.all([
		toPlayer.length
			? adminExecute(MEMBER, 'write', [toPlayer.map((m) => m.id), { x_studio_role: 'player' }])
			: null,
		toSpectator.length
			? adminExecute(MEMBER, 'write', [toSpectator.map((m) => m.id), { x_studio_role: 'spectator' }])
			: null
	].filter(Boolean));

	// keep the caller's in-hand rows in step so a following publicMembers is accurate
	for (const m of toPlayer) m.x_studio_role = 'player';
	for (const m of toSpectator) m.x_studio_role = 'spectator';
	return { promoted: toPlayer.length, demoted: toSpectator.length };
}

/**
 * Apply EXPLICIT role changes — the host seating someone by hand, as opposed to
 * reseatRoles' recompute from join order.
 *
 * These two must stay separate. reseatRoles derives the whole seating from
 * lowest-member-id slicing, so routing a manual promotion through it would
 * immediately re-demote the promoted spectator (their id is by definition higher
 * than the incumbents'). This one moves exactly who it was told to and nobody
 * else, which is what makes "swap this spectator in for that player" expressible.
 *
 * Same write shape and same in-hand mutation contract as reseatRoles: at most one
 * batched Odoo write per target role, and the caller's rows updated so a
 * following publicMembers/pushRoster is accurate. `changes` is [{ id, role }];
 * entries whose row is already in that role are dropped, so it is idempotent.
 */
export async function setRoles(members, changes) {
	const byId = new Map(members.map((m) => [m.id, m]));
	const moving = changes
		.map(({ id, role }) => ({ row: byId.get(Number(id)), role }))
		.filter(({ row, role }) => row && row.x_studio_status === 'accepted' && row.x_studio_role !== role);

	const toPlayer = moving.filter((c) => c.role === 'player').map((c) => c.row);
	const toSpectator = moving.filter((c) => c.role === 'spectator').map((c) => c.row);
	await Promise.all([
		toPlayer.length
			? adminExecute(MEMBER, 'write', [toPlayer.map((m) => m.id), { x_studio_role: 'player' }])
			: null,
		toSpectator.length
			? adminExecute(MEMBER, 'write', [toSpectator.map((m) => m.id), { x_studio_role: 'spectator' }])
			: null
	].filter(Boolean));

	for (const m of toPlayer) m.x_studio_role = 'player';
	for (const m of toSpectator) m.x_studio_role = 'spectator';
	return { promoted: toPlayer.length, demoted: toSpectator.length };
}

/**
 * Clear a finished round so the room can play another: scores back to 0, the
 * chess colour swap armed, the game dropped. Shared by `rematch`, the host's
 * `end` (abort mid-game) and the game-type switch so the three can't drift —
 * the caller persists `state`.
 */
export async function resetRound(state, members) {
	const accepted = members.filter((m) => m.x_studio_status === 'accepted');
	const ids = accepted.map((m) => m.id);
	if (ids.length) await adminExecute(MEMBER, 'write', [ids, { x_studio_score: 0 }]);
	// keep the caller's in-hand rows in step, same as reseatRoles — they feed the
	// roster push and the response body, both of which would otherwise show the
	// scores this call just cleared
	for (const m of accepted) m.x_studio_score = 0;
	// chess: swap colours next round — last game's black plays white next.
	if (state.game?.type === 'chess') state.nextWhiteUid = state.game.players.b;
	state.game = null;
}

/**
 * Who takes the room when the current host goes. Longest-standing accepted
 * member wins — member ids ascend with join order, the same convention
 * reseatRoles uses to decide who keeps a seat. Returns a uid, or null when
 * nobody is left to hand it to (the caller then deletes the room). Pure.
 *
 * `leavingUid` is load-bearing, not just tidiness: callers hold rows read
 * BEFORE they wrote the leaver to 'left', so that row still says `accepted`
 * here and would otherwise elect the departing host their own successor.
 */
export function pickSuccessorHost(members, leavingUid) {
	return (
		members
			.filter(
				(m) => m.x_studio_status === 'accepted' && m.x_studio_user_id?.[0] !== leavingUid
			)
			.sort((a, b) => a.id - b.id)[0]?.x_studio_user_id?.[0] ?? null
	);
}

/** Hand the room to another member. Caller has already authorized this. */
export function setHost(roomId, uid) {
	return adminExecute(ROOM, 'write', [[Number(roomId)], { x_studio_host_id: Number(uid) }]);
}

/** Delete a room and all its rows (FK-safe order: media → events → members → room). */
export async function deleteRoom(roomId) {
	const id = Number(roomId);
	// Chat media dies with the room. Unlinked explicitly rather than leaning on
	// Odoo's implicit attachment cleanup, same as the rows below.
	const media = await adminExecute(ATTACH, 'search', [
		[['res_model', '=', ROOM], ['res_id', '=', id]]
	]);
	if (media.length) await adminExecute(ATTACH, 'unlink', [media]);
	const events = await adminExecute(EVENT, 'search', [[['x_studio_room_id', '=', id]]]);
	if (events.length) await adminExecute(EVENT, 'unlink', [events]);
	const members = await adminExecute(MEMBER, 'search', [[['x_studio_room_id', '=', id]]]);
	if (members.length) await adminExecute(MEMBER, 'unlink', [members]);
	await adminExecute(ROOM, 'unlink', [[id]]);
}

/** Wipe a user's rooms/memberships so their res.users can be unlinked. */
export async function purgeUserRooms(uid) {
	const hosted = await adminExecute(ROOM, 'search', [[['x_studio_host_id', '=', uid]]]);
	for (const id of hosted) await deleteRoom(id); // media→events→members→room
	const mem = await adminExecute(MEMBER, 'search', [[['x_studio_user_id', '=', uid]]]);
	if (mem.length) await adminExecute(MEMBER, 'unlink', [mem]);
}

// Minutes with every member offline → abandoned. Coupled to the presence
// heartbeat: HEARTBEAT_AFTER_MS (45s) and PRESENCE_WINDOW_MS (90s) both have to
// stay far under this, or a room full of people polling exactly as designed gets
// deleted out from under them.
const ABANDON_MIN = 10;
// Ceiling per cron tick. Each deleteRoom is 4-7 sequential Odoo calls, and a
// Workers invocation has a subrequest budget — so an unbounded backlog must
// drain over several ticks rather than blowing one up. At 5-minute ticks this
// clears 240 rooms/hour, far beyond any plausible accumulation.
const SWEEP_BATCH = 20;

/**
 * Best-effort deletion of rooms whose every member has been offline > 10min.
 *
 * Runs on a Cron Trigger (see wrangler.toml), NOT on a request. It used to be
 * lazy GC hung off GET /api/rooms and /api/rooms/mine, throttled to once per 60s
 * by a module-scope timestamp. That throttle assumed one long-lived process; on
 * Workers there are many short-lived isolates, so it would have fired far more
 * often while a user merely listed rooms — each time doing an unbounded serial
 * delete loop. A schedule is both cheaper and honest about what this is.
 */
export async function sweepAbandonedRooms() {
	try {
		const cutoff = new Date(Date.now() - ABANDON_MIN * 60000)
			.toISOString()
			.slice(0, 19)
			.replace('T', ' ');
		// rooms with a recently-seen active member are alive
		const live = await adminExecute(MEMBER, 'search_read', [
			[['x_studio_last_seen', '>', cutoff], ['x_studio_status', 'in', ['accepted', 'pending']]],
			['x_studio_room_id']
		]);
		const liveRoomIds = new Set(live.map((m) => m.x_studio_room_id?.[0]).filter(Boolean));
		// candidates: created before the cutoff (protects fresh rooms nobody polled yet)
		const rooms = await adminExecute(ROOM, 'search_read', [
			[['create_date', '<', cutoff]],
			['id']
		]);
		const dead = rooms.filter((r) => !liveRoomIds.has(r.id)).slice(0, SWEEP_BATCH);
		for (const r of dead) await deleteRoom(r.id);
		if (dead.length) console.log(`sweepAbandonedRooms: deleted ${dead.length} room(s)`);
		return dead.length;
	} catch (e) {
		console.error('sweepAbandonedRooms failed:', e.message);
		return 0;
	}
}

/** Mark the room finished and persist per-user scores onto member rows. */
/**
 * Scores differ per member, so Odoo's multi-id `write` can't batch them — but
 * they're independent rows and can at least go out together instead of one
 * blocking round trip each.
 */
export async function finishRoom(roomId, members, scoresByUid = {}, room = null) {
	const scored = members.filter(
		(m) => m.x_studio_user_id?.[0] != null && scoresByUid[m.x_studio_user_id[0]] != null
	);
	await Promise.all([
		...scored.map((m) =>
			adminExecute(MEMBER, 'write', [[m.id], { x_studio_score: scoresByUid[m.x_studio_user_id[0]] }])
		),
		adminExecute(ROOM, 'write', [[Number(roomId)], { x_studio_status: 'finished' }])
	]);

	// Every game ends through here, so this is the one place that has to announce
	// it. `room` is optional only because it arrived after the eight callers did;
	// without it the final scores and the flip to `finished` reach everyone else
	// no sooner than their next poll.
	if (room) {
		for (const m of scored) m.x_studio_score = scoresByUid[m.x_studio_user_id[0]];
		room.x_studio_status = 'finished';
		await pushRoster(roomId, room, members);
	}
}

export function jsonError(e) {
	const body = { ok: false, error: e?.message || 'Request failed' };
	if (e?.code) body.code = e.code; // let the client tell terminal from transient
	return { body, status: e?.status || 500 };
}

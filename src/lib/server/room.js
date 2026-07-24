// Room-level authorization + state helpers. Identity comes from the user's
// session cookie (requireUser); all Odoo I/O for room data uses the admin key —
// players' own Odoo access is read-only, and the secret-bearing state field is
// admin-group-only, so the proxy is the single write path by construction.
import { adminExecute } from './odoo.js';
import { requireUser } from './auth.js';
import { createSnapshotCache } from './roomcache.js';
import { publishState, publishEvent } from './realtime.js';

// The game list is shared with the client so a select, a capacity preview and a
// validation check can't drift. Re-exported here because every server caller
// already imports from this module.
import { seatedPlayerIds } from '../games.js';
export { GAME_TYPES, playerCapacity } from '../games.js';

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
			'x_studio_max_players', 'x_studio_draws_total', 'x_studio_state']
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
 */
export async function writeState(roomId, state, extraVals = {}) {
	state.v = (state.v || 0) + 1;
	await adminExecute(ROOM, 'write', [
		[Number(roomId)],
		{ ...extraVals, x_studio_state: JSON.stringify(state) }
	]);
	// push the filtered new state straight to each member — no client poll needed
	await publishState(roomId, state, roomUids.get(Number(roomId)) || []);
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
				now - new Date(m.x_studio_last_seen.replace(' ', 'T') + 'Z').getTime() < 15000
		}));
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
		drawsTotal: room.x_studio_draws_total
	};
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
 * Clear a finished round so the room can play another: scores back to 0, the
 * chess colour swap armed, the game dropped. Shared by `rematch` and the
 * game-type switch so the two can't drift — the caller persists `state`.
 */
export async function resetRound(state, members) {
	const ids = members.filter((m) => m.x_studio_status === 'accepted').map((m) => m.id);
	if (ids.length) await adminExecute(MEMBER, 'write', [ids, { x_studio_score: 0 }]);
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

// Lazy GC: run at most once per 60s per Lambda instance (no cron needed).
let _lastSweep = 0;
const SWEEP_THROTTLE_MS = 60000;
const ABANDON_MIN = 10; // minutes with every member offline → abandoned

/** Best-effort deletion of rooms whose every member has been offline > 10min. */
export async function sweepAbandonedRooms() {
	if (Date.now() - _lastSweep < SWEEP_THROTTLE_MS) return;
	_lastSweep = Date.now();
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
		for (const r of rooms) {
			if (!liveRoomIds.has(r.id)) await deleteRoom(r.id);
		}
	} catch (e) {
		console.error('sweepAbandonedRooms failed:', e.message);
	}
}

/** Mark the room finished and persist per-user scores onto member rows. */
/**
 * Scores differ per member, so Odoo's multi-id `write` can't batch them — but
 * they're independent rows and can at least go out together instead of one
 * blocking round trip each.
 */
export async function finishRoom(roomId, members, scoresByUid = {}) {
	const scoreWrites = members
		.filter((m) => m.x_studio_user_id?.[0] != null && scoresByUid[m.x_studio_user_id[0]] != null)
		.map((m) =>
			adminExecute(MEMBER, 'write', [[m.id], { x_studio_score: scoresByUid[m.x_studio_user_id[0]] }])
		);
	await Promise.all([
		...scoreWrites,
		adminExecute(ROOM, 'write', [[Number(roomId)], { x_studio_status: 'finished' }])
	]);
}

export function jsonError(e) {
	const body = { ok: false, error: e?.message || 'Request failed' };
	if (e?.code) body.code = e.code; // let the client tell terminal from transient
	return { body, status: e?.status || 500 };
}

// Room-level authorization + state helpers. Identity comes from the user's
// session cookie (requireUser); all Odoo I/O for room data uses the admin key —
// players' own Odoo access is read-only, and the secret-bearing state field is
// admin-group-only, so the proxy is the single write path by construction.
import { adminExecute } from './odoo.js';
import { requireUser } from './auth.js';

export const ROOM = 'x_gameroom';
export const MEMBER = 'x_room_member';
export const EVENT = 'x_room_event';

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
	return adminExecute(MEMBER, 'search_read', [
		[['x_studio_room_id', '=', Number(roomId)]],
		['x_name', 'x_studio_user_id', 'x_studio_status', 'x_studio_role', 'x_studio_score', 'x_studio_last_seen']
	], { order: 'id asc' });
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
	const mine = members.find((m) => m.x_studio_user_id?.[0] === uid);
	if (!mine || mine.x_studio_status !== 'accepted') {
		// Distinguish the reasons: only some of them mean "stop polling forever".
		// `members` and `room` are already in hand, so this costs no extra Odoo call.
		if ((parseState(room)?.banned || []).includes(uid)) {
			throw httpError(403, 'The host removed you from this room', 'removed');
		}
		if (mine?.x_studio_status === 'pending') {
			throw httpError(403, 'Your join request is still pending', 'pending');
		}
		throw httpError(403, 'You are not a member of this room', 'not_member');
	}
	return { uid, room, member: mine, members };
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
	return state;
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
	return adminExecute(EVENT, 'create', [vals]);
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

/** Delete a room and all its rows (FK-safe order: events → members → room). */
export async function deleteRoom(roomId) {
	const id = Number(roomId);
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

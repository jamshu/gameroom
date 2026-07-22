// Room-level authorization + state helpers. Identity comes from the user's
// session cookie (requireUser); all Odoo I/O for room data uses the admin key —
// players' own Odoo access is read-only, and the secret-bearing state field is
// admin-group-only, so the proxy is the single write path by construction.
import { adminExecute } from './odoo.js';
import { requireUser } from './auth.js';

export const ROOM = 'x_gameroom';
export const MEMBER = 'x_room_member';
export const EVENT = 'x_room_event';

export function httpError(status, message) {
	const e = new Error(message);
	e.status = status;
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

/** Auth + accepted membership. Returns { uid, room, member, members }. */
export async function requireMember(cookies, roomId) {
	const { uid } = await requireUser(cookies);
	const room = await getRoom(roomId);
	const members = await getMembers(roomId);
	const member = members.find(
		(m) => m.x_studio_user_id?.[0] === uid && m.x_studio_status === 'accepted'
	);
	if (!member) throw httpError(403, 'You are not a member of this room');
	return { uid, room, member, members };
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

export async function writeState(roomId, state) {
	state.v = (state.v || 0) + 1;
	await adminExecute(ROOM, 'write', [[Number(roomId)], { x_studio_state: JSON.stringify(state) }]);
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

/** Mark the room finished and persist per-user scores onto member rows. */
export async function finishRoom(roomId, members, scoresByUid = {}) {
	for (const m of members) {
		const uid = m.x_studio_user_id?.[0];
		if (uid != null && scoresByUid[uid] != null) {
			await adminExecute(MEMBER, 'write', [[m.id], { x_studio_score: scoresByUid[uid] }]);
		}
	}
	await adminExecute(ROOM, 'write', [[Number(roomId)], { x_studio_status: 'finished' }]);
}

export function jsonError(e) {
	return { body: { ok: false, error: e?.message || 'Request failed' }, status: e?.status || 500 };
}

// The room DO's only contact with Odoo: hydrate once on first touch, then
// write-behind on an alarm. Nothing here is on a move's critical path — that is
// the entire point of the milestone.
//
// ISOMORPHIC BY CONTRACT — no `$lib`, no `$env`.
import { createOdooAdmin } from '../shared/odoo-admin.js';

export const ROOM_MODEL = 'x_gameroom';
export const MEMBER_MODEL = 'x_room_member';
export const EVENT_MODEL = 'x_room_event';

export function adminFor(env) {
	return createOdooAdmin({
		url: env.ODOO_URL,
		db: env.ODOO_DB,
		username: env.ODOO_USERNAME,
		apiKey: env.ODOO_API_KEY
	});
}

/**
 * Load a room's authoritative rows from Odoo.
 *
 * Returns `maxEventId` alongside the rows because the sequence MUST be seeded
 * above it: clients hold chat keyed by Odoo event ids, and a DO minting from 1
 * would collide with keys already in their store — a duplicate-key crash in a
 * keyed {#each}, not a stalled feed.
 */
export async function hydrate(env, roomId) {
	const odoo = adminFor(env);
	const id = Number(roomId);

	const [rooms, members, maxEvent] = await Promise.all([
		odoo.adminExecute(ROOM_MODEL, 'read', [[id]], {
			fields: ['x_name', 'x_studio_game_type', 'x_studio_status', 'x_studio_host_id',
				'x_studio_max_players', 'x_studio_draws_total', 'x_studio_state',
				'x_studio_visibility', 'x_studio_allowed_user_ids']
		}),
		odoo.adminExecute(MEMBER_MODEL, 'search_read', [
			[['x_studio_room_id', '=', id]],
			['x_name', 'x_studio_user_id', 'x_studio_status', 'x_studio_role', 'x_studio_score', 'x_studio_last_seen']
		], { order: 'id asc' }),
		// Highest event id EVER used by this room, not the highest still present —
		// deleted rows must not let the sequence fall back onto a reused id.
		odoo.adminExecute(EVENT_MODEL, 'search_read', [
			[['x_studio_room_id', '=', id]], ['id']
		], { order: 'id desc', limit: 1 })
	]);

	const row = rooms?.[0];
	if (!row) return null;

	let state = null;
	try {
		state = JSON.parse(row.x_studio_state || 'null') || null;
	} catch {
		// A corrupt blob must not wedge the room forever. Starting empty is
		// recoverable; refusing to hydrate is not.
		console.error(`hydrate: room ${id} has an unparseable state blob`);
	}

	return { row, members, state, maxEventId: maxEvent?.[0]?.id ?? 0 };
}

/** Persist the state blob. The DO owns it now; this is the durable copy. */
export async function writeStateBack(env, roomId, state) {
	const odoo = adminFor(env);
	await odoo.adminExecute(ROOM_MODEL, 'write', [
		[Number(roomId)],
		{ x_studio_state: JSON.stringify(state) }
	]);
}

/**
 * Archive events the DO has accepted but Odoo has not seen.
 *
 * Explicit ids, because the DO's seq IS the Odoo id — that is what keeps one id
 * space across both transports. Odoo's `create` cannot set `id`, so rows the DO
 * minted itself (after the seed, so always above anything Odoo issued) are
 * written with their seq in a studio field and the row id is allowed to differ;
 * the client never sees Odoo's id for those.
 */
export async function archiveEvents(env, roomId, rows) {
	if (!rows.length) return 0;
	const odoo = adminFor(env);
	const id = Number(roomId);
	let written = 0;
	for (const r of rows) {
		try {
			await odoo.adminExecute(EVENT_MODEL, 'create', [{
				x_name: r.type,
				x_studio_room_id: id,
				x_studio_type: r.type,
				x_studio_payload: r.payload,
				x_studio_sender_uid: r.sender || 0,
				...(r.target ? { x_studio_target_uid: r.target } : {})
			}]);
			written++;
		} catch (e) {
			// Best-effort: the log is the source of truth until it drains. Stop on
			// the first failure so ordering is preserved and the retry resumes here.
			console.error(`archiveEvents: room ${id} seq ${r.seq} failed:`, e?.message);
			break;
		}
	}
	return written;
}

/**
 * Refresh last_seen for the uids that currently hold a socket.
 *
 * This is what stops the abandoned-room sweep deleting a room full of people:
 * presence used to ride the poll, and once the poll is gone nothing else feeds
 * it. Batched — one Odoo write per room per minute, against the ~1 req/s budget
 * the whole app shares.
 */
export async function touchLastSeen(env, roomId, members, liveUids) {
	if (!liveUids.length) return 0;
	const odoo = adminFor(env);
	const ids = members
		.filter((m) => liveUids.includes(m.x_studio_user_id?.[0]))
		.map((m) => m.id);
	if (!ids.length) return 0;
	const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
	await odoo.adminExecute(MEMBER_MODEL, 'write', [ids, { x_studio_last_seen: now }]);
	return ids.length;
}

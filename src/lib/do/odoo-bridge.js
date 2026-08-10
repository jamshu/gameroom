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

	const [rooms, members, maxEvent, maxSeq] = await Promise.all([
		odoo.adminExecute(ROOM_MODEL, 'read', [[id]], {
			fields: ['x_name', 'x_studio_game_type', 'x_studio_status', 'x_studio_host_id',
				'x_studio_max_players', 'x_studio_draws_total', 'x_studio_state',
				'x_studio_visibility', 'x_studio_allowed_user_ids']
		}),
		odoo.adminExecute(MEMBER_MODEL, 'search_read', [
			[['x_studio_room_id', '=', id]],
			['x_name', 'x_studio_user_id', 'x_studio_status', 'x_studio_role', 'x_studio_score', 'x_studio_last_seen']
		], { order: 'id asc' }),
		/* Highest event id EVER used by this room, not the highest still present —
		   deleted rows must not let the sequence fall back onto a reused id.

		   BOTH FIELDS, and taking the max of the two is load-bearing rather than
		   belt-and-braces. An archived row now carries `x_studio_seq` BELOW its own
		   Odoo id (Odoo's key is global and runs ahead of a per-room sequence),
		   while rows written before the field existed carry no seq at all. Reading
		   either column alone therefore seeds too low for some room, and a sequence
		   seeded too low mints seqs that collide with events clients already hold.
		   TWO reads, not one row read twice: the highest seq and the highest id can
		   sit on DIFFERENT rows, because the object seeds its sequence above the
		   room's max Odoo id at ownership transfer and mints from there. Hydrate
		   runs once per room, so the extra call is cheap next to getting it wrong. */
		odoo.adminExecute(EVENT_MODEL, 'search_read', [
			[['x_studio_room_id', '=', id]], ['id']
		], { order: 'id desc', limit: 1 }),
		odoo.adminExecute(EVENT_MODEL, 'search_read', [
			[['x_studio_room_id', '=', id]], ['x_studio_seq']
		], { order: 'x_studio_seq desc', limit: 1 })
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

	return {
		row,
		members,
		state,
		maxEventId: Math.max(maxEvent?.[0]?.id ?? 0, maxSeq?.[0]?.x_studio_seq || 0)
	};
}

/**
 * Does this room still exist in Odoo? One read, one field.
 *
 * Asked only after a flush has failed repeatedly, because the answer decides
 * whether the object is retrying something transient or is an ORPHAN — a room
 * deleted upstream by a path that never reached it. An orphan that keeps
 * retrying is the worst shape available: flush() re-arms on failure, so it never
 * hibernates and never stops spending the shared Odoo budget.
 *
 * Deliberately not folded into hydrate(): that is three calls, and this is asked
 * on a failure path where the whole point is to spend as little as possible.
 */
export async function roomExists(env, roomId) {
	const odoo = adminFor(env);
	const rows = await odoo.adminExecute(ROOM_MODEL, 'read', [[Number(roomId)]], { fields: ['id'] });
	return !!rows?.[0];
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
 * The tail of Odoo's event log for a room, oldest first.
 *
 * Read at the OWNERSHIP TRANSFER, not at hydrate, and it is load-bearing three
 * times over. The moment the DO starts minting ids and serving the poll, its own
 * log is the only log — and a DO that hydrated during M2.3 has an empty one:
 *
 *  - a client polling `?since=<odoo id>` would be told the room had no history,
 *  - `oldestSeq` would be 0, so the `gap` flag could never fire,
 *  - and thief-finder would MIS-RESOLVE: resolveClaims rebuilds the claim map
 *    from the whole pick log, so a transfer mid-draw would hand the envelopes
 *    out again from a log holding only the picks that arrived after the flip.
 *
 * REPLAY_MAX rows, matching the poll page the client already expects.
 */
export async function recentEvents(env, roomId, limit = 200) {
	const odoo = adminFor(env);
	const rows = await odoo.adminExecute(EVENT_MODEL, 'search_read', [
		[['x_studio_room_id', '=', Number(roomId)]],
		['x_studio_type', 'x_studio_payload', 'x_studio_sender_uid', 'x_studio_target_uid', 'x_studio_seq']
	], { order: 'id desc', limit });
	return rows.reverse().map((r) => ({
		// The archived seq when there is one, else the Odoo id — which is what a
		// pre-field row's seq always was. Odoo reads an unset integer back as
		// `false` (see below), so `||` is the right test here.
		seq: r.x_studio_seq || r.id,
		type: r.x_studio_type,
		sender: r.x_studio_sender_uid || 0,
		// Odoo reads an unset integer field back as `false`, never null.
		target: r.x_studio_target_uid || null,
		payload: r.x_studio_payload || '{}'
	}));
}

/**
 * Archive events the DO has accepted but Odoo has not seen.
 *
 * THE ARCHIVED ROW CARRIES ITS ORIGINAL SEQ in `x_studio_seq`, and that is what
 * makes an event's id mean the same thing on both sides of the boundary.
 *
 * This used to be left alone deliberately — Odoo assigns its own primary key on
 * create, and while nothing read the archive back on the hot path the mismatch
 * cost nothing. It was not free after all. `appendEvent` dedupes on seq with
 * INSERT OR REPLACE, so a re-own after an evacuation backfilled every DO-minted
 * event under a NEW Odoo id: a second row for a message clients already held,
 * which is duplicate chat and a duplicate key in a keyed {#each}. The poll's
 * Odoo branch had the same problem from the other end, filtering DO seqs against
 * Odoo primary keys that run ahead globally.
 *
 * Rows created before the field existed have no seq; readers fall back to `id`
 * for those, which is exactly what they were using anyway.
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
				// the point of the field — see the note above
				x_studio_seq: r.seq,
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

import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { MEMBER, ROOM, jsonError } from '$lib/server/room.js';

export const prerender = false;

/** Rooms where I have a membership row (any status but rejected/left). */
export async function GET({ cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		// Room reaping moved to the Cron Trigger (see wrangler.toml) — it is an
		// unbounded serial delete loop and has no business on a read request.
		const memberships = await adminExecute(MEMBER, 'search_read', [
			[['x_studio_user_id', '=', uid], ['x_studio_status', 'in', ['pending', 'accepted']]],
			['x_studio_room_id', 'x_studio_status', 'x_studio_role']
		]);
		const roomIds = [...new Set(memberships.map((m) => m.x_studio_room_id?.[0]).filter(Boolean))];
		// No visibility gate needed: a member row already means you were let in.
		// Invited-but-not-yet-joined rooms have no member row, so they show up in
		// browse rather than here — that's correct, not a gap.
		//
		// The `|` arm is what keeps a room you HOST listed once your own member row
		// says 'left'. Nothing deletes rooms automatically any more and DELETE answers
		// to the recorded host, so dropping an owned room off this list is the same as
		// losing the only way to remove it. Folded into this search_read rather than
		// added as its own search: the dashboard hits this on every load, and Odoo is
		// roughly 1 req/s shared across the whole app — a third call here is not free.
		const rooms = await adminExecute(ROOM, 'search_read', [
			['|', ['id', 'in', roomIds], ['x_studio_host_id', '=', uid]],
			['x_name', 'x_studio_game_type', 'x_studio_status', 'x_studio_host_id',
				'x_studio_visibility']
		]);
		if (!rooms.length) return json({ ok: true, rooms: [] });
		const byRoom = Object.fromEntries(memberships.map((m) => [m.x_studio_room_id?.[0], m]));
		return json({
			ok: true,
			rooms: rooms
				.filter(
					(r) =>
						r.x_studio_status !== 'finished' ||
						byRoom[r.id]?.x_studio_status === 'accepted' ||
						// a room you own is yours to see (and delete) in any status
						r.x_studio_host_id?.[0] === uid
				)
				.map((r) => ({
					id: r.id,
					name: r.x_name,
					gameType: r.x_studio_game_type,
					status: r.x_studio_status,
					hostName: r.x_studio_host_id?.[1] || '',
					visibility: r.x_studio_visibility === 'private' ? 'private' : 'public',
					myStatus: byRoom[r.id]?.x_studio_status,
					myRole: byRoom[r.id]?.x_studio_role
				}))
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth.js';
import { getRoom, getMembers, publicRoom, publicMembers, jsonError } from '$lib/server/room.js';

export const prerender = false;

/** Room detail + members. Any authenticated user may view (so they can request to join). */
export async function GET({ params, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const room = await getRoom(params.id);
		const members = await getMembers(params.id);
		const isHost = room.x_studio_host_id === uid;
		const mine = members.find((m) => m.x_studio_user_id === uid);
		return json({
			ok: true,
			room: publicRoom(room),
			members: publicMembers(members),
			me: mine ? { status: mine.x_studio_status, role: mine.x_studio_role } : null,
			isHost
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

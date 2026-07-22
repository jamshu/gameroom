import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { MEMBER, getRoom, getMembers, appendEvent, jsonError, httpError } from '$lib/server/room.js';

export const prerender = false;

/** Request to join a room (pending until host accepts). */
export async function POST({ params, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const room = await getRoom(params.id);
		if (room.x_studio_status === 'finished') throw httpError(409, 'Room is finished');
		const members = await getMembers(params.id);
		const mine = members.find((m) => m.x_studio_user_id?.[0] === uid);
		if (mine?.x_studio_status === 'accepted') return json({ ok: true, status: 'accepted' });
		if (mine?.x_studio_status === 'pending') return json({ ok: true, status: 'pending' });

		if (mine) {
			// rejoin after leave/reject
			await adminExecute(MEMBER, 'write', [[mine.id], { x_studio_status: 'pending' }]);
		} else {
			await adminExecute(MEMBER, 'create', [{
				x_name: String(uid),
				x_studio_room_id: Number(params.id),
				x_studio_user_id: uid,
				x_studio_status: 'pending'
			}]);
		}
		await appendEvent(params.id, 'system', { kind: 'join-request', uid }, uid);
		return json({ ok: true, status: 'pending' });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

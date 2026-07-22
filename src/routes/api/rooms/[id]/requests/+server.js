import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { MEMBER, requireHost, appendEvent, jsonError, httpError } from '$lib/server/room.js';

export const prerender = false;

// Player capacity per game type; overflow accepted members become spectators.
function playerCapacity(room) {
	if (room.x_studio_game_type === 'chess') return 2;
	if (room.x_studio_game_type === 'carroms') return 4;
	return room.x_studio_max_players || 10;
}

/** Host accepts or rejects a pending join request. */
export async function POST({ params, request, cookies }) {
	try {
		const { room, members, uid } = await requireHost(cookies, params.id);
		const { memberId, action } = await request.json();
		const target = members.find((m) => m.id === Number(memberId));
		if (!target) throw httpError(404, 'Request not found');
		if (target.x_studio_status !== 'pending') throw httpError(409, 'Request already handled');
		if (!['accept', 'reject'].includes(action)) throw httpError(400, 'Invalid action');

		if (action === 'reject') {
			await adminExecute(MEMBER, 'write', [[target.id], { x_studio_status: 'rejected' }]);
			return json({ ok: true });
		}

		const playersNow = members.filter(
			(m) => m.x_studio_status === 'accepted' && m.x_studio_role === 'player'
		).length;
		const role = room.x_studio_status === 'lobby' && playersNow < playerCapacity(room) ? 'player' : 'spectator';
		await adminExecute(MEMBER, 'write', [[target.id], { x_studio_status: 'accepted', x_studio_role: role }]);
		await appendEvent(params.id, 'system', { kind: 'member-accepted', uid: target.x_studio_user_id?.[0], role }, uid);
		return json({ ok: true, role });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

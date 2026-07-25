import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import {
	MEMBER,
	requireHost,
	appendEvent,
	playerCapacity,
	pushRoster,
	publicRoom,
	publicMembers,
	jsonError,
	httpError
} from '$lib/server/room.js';

export const prerender = false;

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
			target.x_studio_status = 'rejected';
			await pushRoster(params.id, room, members);
			return json({ ok: true, room: publicRoom(room), members: publicMembers(members) });
		}

		const playersNow = members.filter(
			(m) => m.x_studio_status === 'accepted' && m.x_studio_role === 'player'
		).length;
		const capacity = playerCapacity(room.x_studio_game_type, room.x_studio_max_players);
		const role = room.x_studio_status === 'lobby' && playersNow < capacity ? 'player' : 'spectator';
		await adminExecute(MEMBER, 'write', [[target.id], { x_studio_status: 'accepted', x_studio_role: role }]);
		await appendEvent(params.id, 'system', { kind: 'member-accepted', uid: target.x_studio_user_id?.[0], role }, uid);
		// for the members already in the room. NOT for the new arrival: the token
		// endpoint runs requireMember, so a pending user was never on the channel —
		// they find out by their own poll stopping to 403.
		target.x_studio_status = 'accepted';
		target.x_studio_role = role;
		await pushRoster(params.id, room, members);
		// Echo the rows back, as `host` and `game-type` do. Not just a saved round
		// trip: without them post() falls through to schedule(0), and that poll is
		// served from the 750ms room-snapshot cache — which has NO invalidation and
		// may still hold the pre-approval members. It would land with roomEpoch
		// unchanged, so nothing marks it stale, and it would overwrite the roster we
		// just pushed. Recovery would then be a whole safety poll away.
		return json({ ok: true, role, room: publicRoom(room), members: publicMembers(members) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

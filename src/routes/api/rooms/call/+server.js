import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth.js';
import { adminExecute } from '$lib/server/odoo.js';
import { ROOM, MEMBER, jsonError, httpError } from '$lib/server/room.js';
import { initGame } from '$lib/shared/gamelogic.js';
import { sendToUser } from '$lib/server/push.js';

export const prerender = false;

/**
 * One-tap "call anyone": spin up a private 1:1 video-call room already in play,
 * seat both users as accepted players, and ring the callee's device with a push
 * that opens it. Returns the new room id; the caller navigates in and both
 * clients auto-join the mesh.
 *
 * Best-effort ring: a callee with no push subscription just isn't reached, but
 * the room still exists and they can be sent the link another way.
 */
export async function POST({ request, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const { toUid } = await request.json();
		const target = Number(toUid);
		if (!Number.isInteger(target) || target <= 0) throw httpError(400, 'Invalid user');
		if (target === uid) throw httpError(400, "You can't call yourself");

		const rows = await adminExecute('res.users', 'read', [[uid, target]], { fields: ['name'] });
		const me = rows.find((r) => r.id === uid);
		const them = rows.find((r) => r.id === target);
		if (!them) throw httpError(404, 'User not found');

		// Start it in play, not the lobby, so tapping the push lands both straight in
		// the call rather than a "press Start" screen.
		const game = initGame('videocall', [uid, target], {});
		const roomId = await adminExecute(ROOM, 'create', [{
			x_name: `Call with ${them.name}`,
			x_studio_game_type: 'videocall',
			x_studio_status: 'playing',
			x_studio_host_id: uid,
			x_studio_max_players: 6,
			x_studio_draws_total: 0,
			x_studio_state: JSON.stringify({ v: 0, voice: [], game }),
			x_studio_visibility: 'private',
			x_studio_allowed_user_ids: [[6, 0, [uid, target]]]
		}]);

		for (const u of [uid, target]) {
			await adminExecute(MEMBER, 'create', [{
				x_name: 'member',
				x_studio_room_id: roomId,
				x_studio_user_id: u,
				x_studio_status: 'accepted',
				x_studio_role: 'player'
			}]);
		}

		await sendToUser(target, {
			title: '📹 Incoming call',
			body: `${me?.name || 'Someone'} is calling you`,
			url: `/room/${roomId}`
		});
		return json({ ok: true, roomId });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

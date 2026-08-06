import { json } from '@sveltejs/kit';
import { requireMemberCached, isPrivate, allowedUids, jsonError, httpError } from '$lib/server/room.js';
import { sendToUser } from '$lib/server/push.js';

export const prerender = false;

/**
 * Ring a room member's device — a web push that opens this room. Lets a caller
 * pull an absent member into a video call: they tap the notification and the SW
 * opens /room/[id], which auto-joins the call.
 *
 * Any accepted member may ring any other accepted member (not host-only): in a
 * call, whoever is here wants to fetch whoever isn't. Best-effort — a user with
 * no push subscription simply isn't reachable, and sendToUser no-ops.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMemberCached(cookies, params.id);
		const { toUid } = await request.json();
		const target = Number(toUid);
		if (!Number.isInteger(target) || target <= 0) throw httpError(400, 'Invalid user');
		if (target === uid) throw httpError(400, "You can't call yourself");

		// Ringable: an accepted member (pull them back into the call) OR a private
		// room's invitee who hasn't joined yet (pull them in from the lobby).
		const isMember = members.some(
			(m) => m.x_studio_user_id?.[0] === target && m.x_studio_status === 'accepted'
		);
		const onGuestList = isPrivate(room) && allowedUids(room).includes(target);
		if (!isMember && !onGuestList) throw httpError(404, 'That user is not in this room');

		const caller = members.find((m) => m.x_studio_user_id?.[0] === uid)?.x_studio_user_id?.[1] || 'Someone';
		await sendToUser(target, {
			title: '📹 Incoming call',
			body: `${caller} is calling you to a video call`,
			url: `/room/${params.id}?call=1`,
			requireInteraction: true, // stay on screen until they answer
			tag: `call-${params.id}`,
			vibrate: [600, 400, 600, 400, 600, 400, 600, 400, 600, 400, 600] // ~6s ring
		});
		return json({ ok: true });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

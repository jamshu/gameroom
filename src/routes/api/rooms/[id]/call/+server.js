import { json } from '@sveltejs/kit';
import { requireMemberCached, jsonError, httpError } from '$lib/server/room.js';
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
		const { uid, members } = await requireMemberCached(cookies, params.id);
		const { toUid } = await request.json();
		const target = Number(toUid);
		if (!Number.isInteger(target) || target <= 0) throw httpError(400, 'Invalid user');
		if (target === uid) throw httpError(400, "You can't call yourself");

		const isMember = members.some(
			(m) => m.x_studio_user_id?.[0] === target && m.x_studio_status === 'accepted'
		);
		if (!isMember) throw httpError(404, 'That user is not in this room');

		const caller = members.find((m) => m.x_studio_user_id?.[0] === uid)?.x_studio_user_id?.[1] || 'Someone';
		await sendToUser(target, {
			title: '📹 Incoming call',
			body: `${caller} is calling you to a video call`,
			url: `/room/${params.id}`
		});
		return json({ ok: true });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

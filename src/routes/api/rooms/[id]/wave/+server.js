import { json } from '@sveltejs/kit';
import { requireMemberCached, appendEvent, jsonError } from '$lib/server/room.js';
import { sendToUsers } from '$lib/server/push.js';

export const prerender = false;

/**
 * Wave at the room — "hey, come back".
 *
 * Any accepted member may wave, not just the host: same call as ringing, which
 * is deliberately not host-only because it's the friendly gesture, not a
 * moderation tool.
 *
 * EVERY other accepted member gets a push, presence notwithstanding. This used
 * to split recipients by `onlineUids()` and push only to the absent, on the
 * reasoning that someone with the room open doesn't want a notification for
 * something already on their screen. That reasoning was wrong about what
 * "online" means here: presence is a 90-second `last_seen` heartbeat, so a phone
 * that opened the room and then went into a pocket still reads as online for a
 * minute and a half — and that person is EXACTLY who a wave is for. They got the
 * in-app notice only, on a screen nobody was looking at.
 *
 * The cost of getting it wrong is asymmetric: a duplicate banner for someone
 * staring at the room is a shrug, a wave that silently reaches nobody is the
 * feature not working. `sendToUsers` is two Odoo calls however many recipients
 * there are, so widening the audience is close to free.
 */
export async function POST({ params, cookies }) {
	try {
		const { uid, members } = await requireMemberCached(cookies, params.id);
		const waver = members.find((m) => m.x_studio_user_id?.[0] === uid);
		const name = waver?.x_studio_user_id?.[1] || 'Someone';

		// The event goes to the whole room regardless of who gets a push: it is what
		// drives the in-app notice, and a client that is present but whose last_seen
		// has drifted stale still deserves to see it.
		await appendEvent(params.id, 'system', { kind: 'wave', uid }, uid);

		const recipients = members
			.filter((m) => m.x_studio_status === 'accepted')
			.map((m) => m.x_studio_user_id?.[0])
			.filter((u) => u && u !== uid);

		if (recipients.length) {
			await sendToUsers(recipients, {
				title: '👋 Someone waved',
				body: `${name} waved at you from the room`,
				// Plain room URL, NOT ?call=1 — that param auto-joins the video mesh on
				// arrival, which is not what a wave is asking for.
				url: `/room/${params.id}`,
				// `wave-` and not `call-`: the service worker gives any `call-` tag the
				// incoming-call treatment (persistent, Answer/Decline actions). The tag
				// still collapses repeat waves into one notification.
				tag: `wave-${params.id}`
			});
		}
		return json({ ok: true, pushed: recipients.length });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

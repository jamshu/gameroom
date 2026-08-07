import { json } from '@sveltejs/kit';
import { requireMemberCached, onlineUids, appendEvent, jsonError } from '$lib/server/room.js';
import { sendToUsers } from '$lib/server/push.js';

export const prerender = false;

/**
 * Wave at the room — "hey, come back".
 *
 * Any accepted member may wave, not just the host: same call as ringing, which
 * is deliberately not host-only because it's the friendly gesture, not a
 * moderation tool.
 *
 * Recipients are SPLIT by presence rather than all being pushed. Someone with
 * the room already open does not want a system notification for it, and a push
 * they can already see is the kind of noise that gets notifications turned off
 * for good — they get the in-app notice the system event already produces. Only
 * people who are actually away get a push.
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

		const online = onlineUids(members);
		const absent = members
			.filter((m) => m.x_studio_status === 'accepted')
			.map((m) => m.x_studio_user_id?.[0])
			.filter((u) => u && u !== uid && !online.has(u));

		if (absent.length) {
			await sendToUsers(absent, {
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
		return json({ ok: true, pushed: absent.length });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

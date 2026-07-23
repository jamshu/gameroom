import { json } from '@sveltejs/kit';
import { requireMember, jsonError } from '$lib/server/room.js';
import { roomTokenRequest } from '$lib/server/realtime.js';

export const prerender = false;

/** Ably token scoped to one room's channel — only for an accepted member. */
export async function GET({ url, cookies }) {
	try {
		const room = url.searchParams.get('room');
		const { uid } = await requireMember(cookies, room);
		const tokenRequest = await roomTokenRequest(room, uid);
		// Ably not configured — tell the client to stay on polling.
		if (!tokenRequest) return json({ ok: false, error: 'Realtime disabled' }, { status: 501 });
		return json(tokenRequest); // Ably's authUrl consumes this token request directly
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

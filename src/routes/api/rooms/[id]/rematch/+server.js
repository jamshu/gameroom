import { json } from '@sveltejs/kit';
import { requireHost, returnToLobby, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Host resets a finished room back to the lobby for another round (scores → 0). */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		if (room.x_studio_status !== 'finished') throw httpError(409, 'Game is not finished');

		// Shared with the idle-reset cron so a host's rematch and an automatic one
		// leave the room in exactly the same shape. `kind` is what differs: only
		// this one was asked for by a person.
		const state = await returnToLobby(params.id, room, members, { senderUid: uid, kind: 'rematch' });
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

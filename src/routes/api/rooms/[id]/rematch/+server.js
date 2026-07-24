import { json } from '@sveltejs/kit';
import { requireHost, appendEvent, parseState, writeState, resetRound, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Host resets a finished room back to the lobby for another round (scores → 0). */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		if (room.x_studio_status !== 'finished') throw httpError(409, 'Game is not finished');

		const state = parseState(room) || { v: 0, voice: [], game: null };
		// keep state.voice intact — a rematch resets the game, not the live call
		await resetRound(state, members);
		await writeState(params.id, state, { x_studio_status: 'lobby' });
		await appendEvent(params.id, 'system', { kind: 'rematch' }, uid);
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

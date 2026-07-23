import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { MEMBER, requireHost, appendEvent, parseState, writeState, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Host resets a finished room back to the lobby for another round (scores → 0). */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		if (room.x_studio_status !== 'finished') throw httpError(409, 'Game is not finished');

		// reset scores on every still-present member
		const memberIds = members
			.filter((m) => m.x_studio_status === 'accepted')
			.map((m) => m.id);
		if (memberIds.length) await adminExecute(MEMBER, 'write', [memberIds, { x_studio_score: 0 }]);

		const state = parseState(room) || { v: 0, voice: [], game: null };
		// keep state.voice intact — a rematch resets the game, not the live call
		state.game = null;
		await writeState(params.id, state, { x_studio_status: 'lobby' });
		await appendEvent(params.id, 'system', { kind: 'rematch' }, uid);
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

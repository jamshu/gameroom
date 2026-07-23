import { json } from '@sveltejs/kit';
import { requireHost, appendEvent, parseState, writeState, jsonError, httpError } from '$lib/server/room.js';
import { initGame, stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Host starts the game with the accepted players. */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		if (room.x_studio_status !== 'lobby') throw httpError(409, 'Game already started');

		const playerUids = members
			.filter((m) => m.x_studio_status === 'accepted' && m.x_studio_role === 'player')
			.map((m) => m.x_studio_user_id?.[0]);

		const state = parseState(room) || { v: 0, voice: [], game: null };
		// chess colour swap: initGame makes playerUids[0] white, so put last
		// round's black player first. Consume the flag so it applies once.
		if (room.x_studio_game_type === 'chess' && state.nextWhiteUid && playerUids.includes(state.nextWhiteUid)) {
			playerUids.sort((a, b) => (a === state.nextWhiteUid ? -1 : b === state.nextWhiteUid ? 1 : 0));
		}
		delete state.nextWhiteUid;
		state.game = initGame(room.x_studio_game_type, playerUids, room);
		await writeState(params.id, state, { x_studio_status: 'playing' });
		await appendEvent(params.id, 'system', { kind: 'game-started', players: playerUids }, uid);
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

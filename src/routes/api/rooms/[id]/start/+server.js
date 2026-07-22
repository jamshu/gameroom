import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { ROOM, requireHost, appendEvent, parseState, writeState, jsonError, httpError } from '$lib/server/room.js';
import { initGame } from '$lib/server/gamelogic.js';

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
		state.game = initGame(room.x_studio_game_type, playerUids, room);
		await writeState(params.id, state);
		await adminExecute(ROOM, 'write', [[Number(params.id)], { x_studio_status: 'playing' }]);
		await appendEvent(params.id, 'system', { kind: 'game-started', players: playerUids }, uid);
		return json({ ok: true });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

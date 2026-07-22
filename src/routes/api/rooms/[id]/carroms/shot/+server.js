import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, finishRoom, jsonError, httpError } from '$lib/server/room.js';
import { carromsApplyShot, carromTeamOf } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Current player posts the settled result of their shot (trusted physics). */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'carroms') throw httpError(409, 'No carroms game in progress');
		if (game.players[game.turnIdx] !== uid) throw httpError(409, 'Not your turn');

		const body = await request.json();
		const outcome = carromsApplyShot(game, uid, body);

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', {
			by: uid,
			pocketed: body.pocketed || [],
			strikerPocketed: !!body.strikerPocketed,
			v: state.v
		}, uid);

		if (game.result) {
			const scores = {};
			for (const puid of game.players) {
				scores[puid] = game.scores[carromTeamOf(game, puid)] || 0;
			}
			await finishRoom(params.id, members, scores);
			await appendEvent(params.id, 'system', { kind: 'game-over', result: game.result }, uid);
		}
		return json({ ok: true, ...outcome, result: game.result });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

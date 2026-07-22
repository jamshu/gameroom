import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, finishRoom, jsonError, httpError } from '$lib/server/room.js';
import { thiefGuess, stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** The Police accuses someone of being the Thief. */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'thief_finder') throw httpError(409, 'No thief-finder game in progress');

		const { accusedUid } = await request.json();
		const result = thiefGuess(game, uid, Number(accusedUid));

		await writeState(params.id, state);
		await appendEvent(params.id, 'system', {
			kind: 'draw-result',
			draw: result.draw,
			accusedUid: result.accusedUid,
			thiefUid: result.thiefUid,
			correct: result.correct
		}, uid);

		if (game.phase === 'finished') {
			await finishRoom(params.id, members, game.totals);
			await appendEvent(params.id, 'system', { kind: 'game-over' }, uid);
		}
		return json({ ok: true, correct: result.correct, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { ludoRoll, stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/**
 * The current player rolls the die.
 *
 * The SERVER picks the number — same CSPRNG treatment the thief_finder deal
 * gets. The client used to send a value derived from how far the player swiped,
 * which meant anyone could throw a 6 on demand. The client now only says "roll";
 * the die it animates is the one that comes back in the response.
 *
 * A `die` in the body is ignored rather than rejected: this is a PWA with a
 * precached shell, so a client running yesterday's bundle is normal and a 400
 * would strand a live game.
 */
export async function POST({ params, cookies }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'ludo') throw httpError(409, 'No ludo game in progress');

		const die = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 6);
		ludoRoll(game, uid, die);

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind: 'roll', die, uid }, uid);
		return json({ ok: true, die, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

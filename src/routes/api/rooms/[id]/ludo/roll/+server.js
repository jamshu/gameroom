import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { ludoRoll, stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** The current player rolls the die. The value comes from the player's swipe on
 *  the client (a deliberate design choice — the throw is user-controlled, not
 *  server-random). We still validate it's a plain 1-6 so the move logic can't be
 *  corrupted, and fall back to a random roll if none/an invalid one is sent. */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'ludo') throw httpError(409, 'No ludo game in progress');

		const body = await request.json().catch(() => ({}));
		let die = Number(body?.die);
		if (!Number.isInteger(die) || die < 1 || die > 6) {
			die = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 6);
		}
		ludoRoll(game, uid, die);

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind: 'roll', die, uid }, uid);
		return json({ ok: true, die, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

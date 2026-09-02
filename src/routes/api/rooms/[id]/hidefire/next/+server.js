import { json } from '@sveltejs/kit';
import { requireMemberCached, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';
import { nextRound } from '$lib/shared/hidefire.js';

export const prerender = false;

/**
 * Start the next round in place: swap sides, carry the score, reset the clock.
 *
 * Deliberately NOT the shared /rematch endpoint — that returns the room to its
 * lobby and clears everything, which would drop the running score and the "you
 * hid last round, now you seek" hand-off. Guarded on `result` so a double-tap or
 * a late straggler can't advance the round twice.
 */
export async function POST({ params, cookies }) {
	try {
		// Cached read (state overlay stays fresh): several players may tap "Next
		// round" at once — the guard on `result` dedupes, but the uncached auth reads
		// would still each hit Odoo twice. Mirror of the hit route.
		const { uid, room } = await requireMemberCached(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'hidefire') throw httpError(409, 'No Hide & Fire game in progress');
		if (!game.result) throw httpError(409, 'Round is still in progress');

		state.game = nextRound(game);

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind: 'next', by: uid, v: state.v }, uid);
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

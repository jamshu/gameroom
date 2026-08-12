import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';
import { hit } from '$lib/shared/blackjack.js';
import { settleBlackjack } from '$lib/server/blackjack-settle.js';

export const prerender = false;

/** Draw a card. A bust ends the seat and may resolve the dealer + round. */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'blackjack') throw httpError(409, 'No Blackjack game in progress');

		const res = hit(game, uid);

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind: 'hit', uid, bust: res.bust, v: state.v }, uid);
		if (game.result === 'done') await settleBlackjack(params.id, state, members, room, uid);
		return json({ ok: true, bust: res.bust, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

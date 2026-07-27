import { json } from '@sveltejs/kit';
import { requireHost, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { thiefDeal, stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/** Host lays the envelopes for the next draw; players open them to get their cards. */
export async function POST({ params, cookies }) {
	try {
		const { uid, room } = await requireHost(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'thief_finder') throw httpError(409, 'No thief-finder game in progress');
		// The draw thiefDeal's phase guard was just decided against.
		const baseDraw = game.draw;

		thiefDeal(game);
		// stillValid, not guardVersion: two deals racing is not contention to be
		// ordered, it is one deal too many. Both read `phase: 'reveal'`, both clear
		// that guard, and both write a DIFFERENT envelope→role shuffle — so the
		// round's roles would come down to which write landed last. Ordering them
		// only makes the room agree on a shuffle; refusing is what stops the second
		// deal reshuffling a draw already under way. The host's auto-deal timer
		// retries once, so this genuinely does fire.
		//
		// The precondition is the DRAW, not the version: another deal has advanced
		// it, whereas a mic toggle or a chat message bumps the version without
		// touching the game and must not cost the host their deal.
		await writeState(params.id, state, {}, {
			stillValid: (fresh) => (fresh?.game?.draw ?? baseDraw) === baseDraw
		});
		await appendEvent(params.id, 'system', {
			kind: 'draw-dealt',
			draw: game.draw,
			envelopeCount: game.envelopes.length
		}, uid);
		// echo the caller's filtered view so they don't pay an extra poll for it
		return json({ ok: true, draw: game.draw, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

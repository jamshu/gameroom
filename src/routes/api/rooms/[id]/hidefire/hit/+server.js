import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';
import { applyHit, resolve } from '$lib/shared/hidefire.js';

export const prerender = false;

/**
 * Register a kill and/or resolve the round.
 *
 * Client-authoritative: the shooter's Godot raycast decided the hit, so the body
 * carries the victim's uid. Called with NO victim by the host's clock watcher
 * when the 90s timer expires, so `resolve` can hand the round to the surviving
 * hiders — one endpoint covers both the kill and the timeout.
 * // ponytail: shooter trusted, no server position check — add one here if
 * // cheating ever matters.
 */
export async function POST({ params, cookies, request }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'hidefire') throw httpError(409, 'No Hide & Fire game in progress');

		const { victim } = await request.json().catch(() => ({}));
		const killed = victim != null ? applyHit(game, Number(victim)).killed : false;
		const result = resolve(game);

		await writeState(params.id, state);
		await appendEvent(params.id, 'move', { kind: 'hit', by: uid, victim: victim ?? null, killed, result, v: state.v }, uid);
		return json({ ok: true, killed, result, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

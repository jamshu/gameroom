import { json } from '@sveltejs/kit';
import { requireHost, appendEvent, parseState, writeState, resetRound, pushRoster, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/**
 * Host aborts a round in progress and takes the room back to the lobby.
 *
 * Long games (chess, carroms, ludo) otherwise have exactly two exits — play to a
 * finish, or a seated player walks out and drops the round for everyone. Neither
 * lets the host re-seat people or change game while a game is running.
 *
 * Deliberately NOT folded into `rematch`: that one means "the round finished,
 * run another" and 409s on anything but `finished`. Keeping them apart is also
 * what lets the two write different system events, so the announcement can say
 * whether the round was completed or cut short.
 */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		if (room.x_studio_status !== 'playing') throw httpError(409, 'No game in progress');

		const state = parseState(room) || { v: 0, voice: [], game: null };
		// same reset as a rematch — scores cleared, chess colours swapped for next
		// time, game dropped. Nulling state.game is load-bearing beyond tidiness:
		// thief-finder mints a fresh `epoch` at the next initGame, which is what stops
		// this round's picks replaying out of the append-only event log.
		// state.voice is untouched: ending the game doesn't end the call.
		await resetRound(state, members);
		await writeState(params.id, state, { x_studio_status: 'lobby' });
		await appendEvent(params.id, 'system', { kind: 'game-ended' }, uid);
		// `playing → lobby` plus the scores resetRound just cleared: both live on rows
		// the state push doesn't carry. resetRound updated the members in hand.
		room.x_studio_status = 'lobby';
		await pushRoster(params.id, room, members);
		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

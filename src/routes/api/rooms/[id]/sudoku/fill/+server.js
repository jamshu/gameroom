import { json } from '@sveltejs/kit';
import {
	requireMember,
	parseState,
	writeState,
	appendEvent,
	finishRoom,
	jsonError,
	httpError
} from '$lib/server/room.js';
import { stateView, applySudokuFill, sudokuScores, winnerUids } from '$lib/server/gamelogic.js';
import { isDoRoom } from '$lib/server/doflag.js';
import { doOp, isEvacuated } from '$lib/server/dostub.js';

export const prerender = false;

/**
 * One digit into the caller's own grid.
 *
 * Every player in a sudoku race writes at the same time, so this takes the same
 * shape as thief/pick: the Durable Object applies it inside the object, where a
 * second fill cannot interleave, and the Odoo seam is only the evacuated
 * fallback. The difference from thief-finder is that two fills never CONFLICT —
 * each player writes only `boards[uid]` — so there is nothing to rank, only to
 * merge. See raceWrite in do/room-do.js and the note on contendedProgress.
 *
 * Validation lives on the server because the client does not have (and must
 * never have) the solution: a wrong digit is rejected here, counted, and costs
 * the player a ten-second freeze that is enforced here too.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		// Read once — the body is a stream and the fallback below would otherwise
		// reach the Odoo path with it already consumed.
		const { cell, digit } = await request.json();

		if (isDoRoom(params.id)) {
			const res = await doOp(params.id, { op: 'sudokuFill', uid, cell, digit });
			if (res?.ok) {
				// The room only finishes when this fill completed a grid. Scoring stays
				// on the seam rather than in the object because finishRoom writes member
				// rows in Odoo, which the object deliberately does not do.
				if (res.won) await settle(params.id, res.state, members, room, uid);
				return json({
					ok: true,
					correct: res.correct,
					frozenUntil: res.frozenUntil ?? 0,
					mistakes: res.mistakes,
					state: stateView(res.state, uid)
				});
			}
			if (!isEvacuated(res)) {
				throw httpError(res?.status || 503, res?.error || 'The room is busy — try again', res?.code);
			}
			// evacuated — fall through to the Odoo path, which is authoritative again
		}

		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'sudoku') throw httpError(409, 'No sudoku game in progress');

		const res = applySudokuFill(game, uid, cell, digit);
		if (!res.ok) throw httpError(res.status || 400, res.error, res.code);

		/* guardVersion, for the same reason thief/pick uses it: on this path
		   `state.v` was read a round trip ago and several players are typing at
		   once. Unlike thief-finder there is no equal-version tiebreak to fall back
		   on (contendedProgress covers only that game, by design), so a conflicting
		   fill is REFUSED rather than silently ordered — the player retypes the
		   digit. Degraded, but only ever reached while a room is evacuated. */
		await writeState(params.id, state, {}, { guardVersion: true });
		if (res.won) await settle(params.id, state, members, room, uid);

		return json({
			ok: true,
			correct: res.correct,
			frozenUntil: res.frozenUntil ?? 0,
			mistakes: res.mistakes,
			state: stateView(state, uid)
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

/** Credit the win and announce it. Shared by both paths so they cannot drift. */
async function settle(roomId, state, members, room, uid) {
	const game = state?.game;
	if (!game) return;
	await finishRoom(roomId, members, sudokuScores(game), room, {
		state,
		winners: winnerUids(game)
	});
	await appendEvent(
		roomId,
		'system',
		{
			kind: 'game-over',
			result: game.result,
			by: 'solved',
			endReason: 'solved',
			winnerUid: game.result ?? null
		},
		uid
	);
}

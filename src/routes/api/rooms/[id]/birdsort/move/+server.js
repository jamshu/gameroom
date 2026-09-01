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
import { stateView, applyBirdsortMove, closeBirdsort, birdsortScores, winnerUids } from '$lib/server/gamelogic.js';
import { isDoRoom } from '$lib/server/doflag.js';
import { doOp, isEvacuated } from '$lib/server/dostub.js';

export const prerender = false;

/**
 * One pour into the caller's own tubes. Same shape as sudoku/fill: every player
 * in a bird-sort race writes at the same time, and each only ever touches their
 * own `boards[uid]`, so there is nothing to rank, only to apply. The Durable
 * Object runs it where a second pour cannot interleave; the Odoo seam is the
 * evacuated fallback. Validation lives on the server — the move is legal or it
 * is refused — so "first to sort" cannot be faked by a doctored client.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const { from, to } = await request.json();

		if (isDoRoom(params.id)) {
			const res = await doOp(params.id, { op: 'birdsortMove', uid, from, to });
			if (res?.ok) {
				if (res.won) await settle(params.id, res.state, members, room, uid);
				return json({ ok: true, moves: res.moves, finished: res.finished, state: stateView(res.state, uid) });
			}
			if (!isEvacuated(res)) {
				throw httpError(res?.status || 503, res?.error || 'The room is busy — try again', res?.code);
			}
			// evacuated — fall through to the Odoo path, which is authoritative again
		}

		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'birdsort') throw httpError(409, 'No bird sort game in progress');

		const res = applyBirdsortMove(game, uid, from, to);
		closeBirdsort(game); // end a timed-out puzzle nobody solved; no-op otherwise
		if (!res.ok && !game.result) throw httpError(res.status || 400, res.error, res.code);

		// guardVersion: `state.v` was read a round trip ago and several players pour
		// at once; a conflicting write is refused rather than silently ordered. Only
		// reached while a room is evacuated. See the same note in sudoku/fill.
		await writeState(params.id, state, {}, { guardVersion: true });
		if (res.won || game.result) await settle(params.id, state, members, room, uid);

		return json({ ok: true, moves: res.moves, finished: res.finished, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

/** Credit the win and announce it. Shared by both paths so they cannot drift. */
async function settle(roomId, state, members, room, uid) {
	const game = state?.game;
	if (!game) return;
	await finishRoom(roomId, members, birdsortScores(game), room, {
		state,
		winners: winnerUids(game)
	});
	await appendEvent(
		roomId,
		'system',
		{
			kind: 'game-over',
			result: game.result,
			by: 'sorted',
			endReason: 'sorted',
			winnerUid: game.result ?? null
		},
		uid
	);
}

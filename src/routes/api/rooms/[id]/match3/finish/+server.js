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
import {
	stateView, applyMatch3Finish, closeMatch3, match3Scores, winnerUids
} from '$lib/server/gamelogic.js';
import { isDoRoom } from '$lib/server/doflag.js';
import { doOp, isEvacuated } from '$lib/server/dostub.js';

export const prerender = false;

/**
 * Report a finished match-3 round.
 *
 * The client notices its own clock has run out and POSTs; the server recomputes
 * expiry from ITS OWN `startedAt` and refuses anything early — the same
 * arrangement chess/flag uses, and the reason no Durable Object alarm is needed.
 *
 * The reported score is clamped, not trusted. It has to come from the client
 * because the refill queue is generated client-side from the shared seed (see
 * shared/match3.js), so there is no cheap server-side score to compare against.
 * `scoreCeiling` sits an order of magnitude above good play: it never touches an
 * honest round and refuses a fabricated one. The swap log is stored so `replay()`
 * can turn this into real validation later without a data migration.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireMember(cookies, params.id);
		const { score, swaps, log } = await request.json().catch(() => ({}));
		const report = { score, swaps, log };

		if (isDoRoom(params.id)) {
			const res = await doOp(params.id, { op: 'match3Finish', uid, report });
			if (res?.ok) {
				if (res.state?.game?.result) await settle(params.id, res.state, members, room, uid);
				return json({ ok: true, score: res.score, state: stateView(res.state, uid) });
			}
			if (!isEvacuated(res)) {
				throw httpError(res?.status || 503, res?.error || 'The room is busy — try again', res?.code);
			}
			// evacuated — fall through to the Odoo path
		}

		const state = parseState(room);
		const game = state?.game;
		if (!game || game.type !== 'match3') throw httpError(409, 'No Candy Match game in progress');

		const res = applyMatch3Finish(game, uid, report);
		// Attempt the close even if the report was refused — a player who already
		// reported comes back after the grace window purely to trigger this, and it
		// is the only thing that ends a round somebody never reported into.
		const closed = closeMatch3(game);
		if (!res.ok && !closed) throw httpError(res.status || 400, res.error, res.code);

		await writeState(params.id, state, {}, { guardVersion: true });
		if (game.result) await settle(params.id, state, members, room, uid);

		return json({ ok: true, score: res.score, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

/** Credit the winner(s) and announce it. Shared by both paths. */
async function settle(roomId, state, members, room, uid) {
	const game = state?.game;
	if (!game) return;
	const winners = winnerUids(game);
	await finishRoom(roomId, members, match3Scores(game), room, { state, winners });
	await appendEvent(
		roomId,
		'system',
		{
			kind: 'game-over',
			result: game.result,
			by: 'time',
			endReason: 'time',
			// A tie has several; the room banner names the first and the leaderboard
			// shows the rest, the same way carroms reports a doubles win.
			winnerUid: winners[0] ?? null
		},
		uid
	);
}

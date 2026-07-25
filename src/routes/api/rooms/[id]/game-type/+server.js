import { json } from '@sveltejs/kit';
import {
	GAME_TYPES,
	requireHost,
	appendEvent,
	parseState,
	writeState,
	reseatRoles,
	resetRound,
	publicRoom,
	publicMembers,
	pushRoster,
	jsonError,
	httpError
} from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/**
 * Host switches the room to a different game without rebuilding the room —
 * members, chat and the live voice call all survive.
 *
 * Accepts `finished` as well as `lobby`: from the final leaderboard this is
 * "play again as <other game>", so it folds in the same round reset `rematch`
 * does rather than making the client chain two POSTs.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		const { gameType, drawsTotal } = await request.json();

		if (!GAME_TYPES.includes(gameType)) throw httpError(400, 'Pick a game');
		const status = room.x_studio_status;
		if (status !== 'lobby' && status !== 'finished') {
			throw httpError(409, 'You can only change the game before it starts');
		}

		// same rule as room creation; an existing thief room keeps its setting
		let draws = 0;
		if (gameType === 'thief_finder') {
			draws = Number(drawsTotal ?? room.x_studio_draws_total) || 5;
			if (![5, 10].includes(draws)) throw httpError(400, 'Choose 5 or 10 draws');
		}

		const state = parseState(room) || { v: 0, voice: [], game: null };
		if (status === 'finished') await resetRound(state, members);
		state.game = null;
		// nextWhiteUid is chess-only and read blindly by `start`. resetRound arms it,
		// so drop it AFTER — but only when the new game isn't chess, or a chess →
		// chess "play again" would lose its colour swap.
		if (gameType !== 'chess') delete state.nextWhiteUid;

		// The point of the whole endpoint: roles are otherwise fixed at accept time
		// against the OLD game's capacity, and `start` would reject the room.
		const { promoted, demoted } = await reseatRoles(members, gameType, room.x_studio_max_players);

		const from = room.x_studio_game_type;
		await writeState(params.id, state, {
			x_studio_game_type: gameType,
			x_studio_draws_total: draws,
			x_studio_status: 'lobby'
		});
		// kept for the room feed — this is a notification, not the transport. The
		// roster push below is what actually moves the new game type.
		await appendEvent(params.id, 'system', { kind: 'game-type-changed', gameType, from }, uid);

		// reflect the new values so the acting host's own view updates from the
		// response instead of waiting for their next poll
		room.x_studio_game_type = gameType;
		room.x_studio_draws_total = draws;
		room.x_studio_status = 'lobby';

		// …and everyone else's from the push. reseatRoles already brought the member
		// rows in hand up to date, so these are the post-write values.
		await pushRoster(params.id, room, members);

		// members too: re-seating rewrote roles, and because this response carries
		// state the store won't schedule a catch-up poll to go and fetch them.
		// `reseatRoles` already updated the rows in hand.
		return json({
			ok: true,
			state: stateView(state, uid),
			room: publicRoom(room),
			members: publicMembers(members),
			reseated: { promoted, demoted }
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

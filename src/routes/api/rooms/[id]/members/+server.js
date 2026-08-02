import { json } from '@sveltejs/kit';
import {
	requireHost,
	parseState,
	writeState,
	appendEvent,
	pushRoster,
	dropMember,
	isPrivate,
	allowedUids,
	jsonError,
	httpError
} from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

/**
 * Host removes an accepted member.
 *
 * Deliberately NOT allowed for an active player mid-game: `game.players` is a
 * frozen snapshot taken at start and is never reconciled, so pulling a player
 * out would permanently wedge the room — chess and carroms would sit forever on
 * a turn nobody can take, and thief-finder would stall if the Police vanished.
 * There is no resign, skip-turn or turn-timeout anywhere to recover from that.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		const { memberId, action } = await request.json();
		if (action !== 'remove') throw httpError(400, 'Invalid action');

		const target = members.find((m) => m.id === Number(memberId));
		if (!target) throw httpError(404, 'Member not found');

		const targetUid = target.x_studio_user_id?.[0];
		if (targetUid === room.x_studio_host_id?.[0]) {
			throw httpError(400, 'You cannot remove yourself — leave the room instead');
		}
		if (target.x_studio_status !== 'accepted') {
			throw httpError(409, 'Use join requests to handle pending members');
		}
		if (room.x_studio_status !== 'lobby' && target.x_studio_role !== 'spectator') {
			throw httpError(409, 'You can only remove players before the game starts');
		}

		const state = parseState(room) || { v: 0, voice: [], game: null };
		// row → 'left', out of voice, marked removed-by-host. Shared with the private
		// room's guest list so the two ways out of a room behave identically.
		await dropMember(target, state, params.id);

		// A private room's guest list is what lets someone in, and `join` auto-accepts
		// anyone on it — so without this the removed player walks straight back in.
		// Folded into the state write via extraVals rather than a second ROOM write.
		const kept = isPrivate(room) ? allowedUids(room).filter((u) => u !== targetUid) : null;
		await writeState(params.id, state, kept ? { x_studio_allowed_user_ids: [[6, 0, kept]] } : {});
		if (kept) room.x_studio_allowed_user_ids = kept;

		await appendEvent(params.id, 'system', { kind: 'member-removed', uid: targetUid }, uid);

		// everyone still here sees the roster shrink at once. The removed player's
		// own exit still rides the poll's coded 403 (`removed`), which is what the
		// store treats as terminal — the roster alone doesn't stop them polling.
		await pushRoster(params.id, room, members);

		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

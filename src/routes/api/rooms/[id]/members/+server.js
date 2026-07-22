import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import {
	MEMBER,
	requireHost,
	parseState,
	writeState,
	appendEvent,
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

		// 'left', not 'rejected': publicMembers filters `rejected` out entirely,
		// which would retroactively degrade their name to `#uid` across chat history.
		await adminExecute(MEMBER, 'write', [[target.id], { x_studio_status: 'left' }]);

		const state = parseState(room) || { v: 0, voice: [], game: null };
		// drop them from voice so the remaining peers tear the connection down
		// (mesh.sync already prunes anyone absent from the roster)
		state.voice = (state.voice || []).filter((u) => u !== targetUid);
		// `banned` blocks the instant re-request that `join` would otherwise allow
		// by flipping a 'left' row back to 'pending'. It lives in room state, which
		// stateView never serializes — so it cannot leak to clients.
		state.banned = [...new Set([...(state.banned || []), targetUid])];
		await writeState(params.id, state);
		await appendEvent(params.id, 'system', { kind: 'member-removed', uid: targetUid }, uid);

		return json({ ok: true, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

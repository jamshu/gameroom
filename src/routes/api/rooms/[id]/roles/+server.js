import { json } from '@sveltejs/kit';
import {
	requireHost,
	setRoles,
	playerCapacity,
	publicRoom,
	publicMembers,
	appendEvent,
	pushRoster,
	jsonError,
	httpError
} from '$lib/server/room.js';

export const prerender = false;

/**
 * Host seats or unseats one member: `{ memberId, role, demoteMemberId? }`.
 *
 * Roles were previously only ever assigned at accept time (first come, first
 * seated) or recomputed wholesale by reseatRoles on a game-type switch — so in
 * chess the two lowest member ids were the only people who could ever play in a
 * room. This is the manual override.
 *
 * LOBBY ONLY. `game.players` is a frozen snapshot taken at start and never
 * reconciled, so re-seating mid-game would leave the board playing the old pair
 * while the roster claimed otherwise. The host's `end` endpoint is the way to
 * get back to a lobby first.
 *
 * Note this does NOT call reseatRoles: that derives seating purely from join
 * order and would instantly undo the promotion. See setRoles in server/room.js.
 * The flip side is that a later game-type switch DOES run reseatRoles and will
 * discard the arrangement made here — correct, since capacity changes with it.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		if (room.x_studio_status !== 'lobby') {
			throw httpError(409, 'You can only change seats before the game starts');
		}

		const { memberId, role, demoteMemberId } = await request.json();
		if (role !== 'player' && role !== 'spectator') throw httpError(400, 'Invalid role');

		const target = members.find((m) => m.id === Number(memberId));
		if (!target) throw httpError(404, 'Member not found');
		if (target.x_studio_status !== 'accepted') {
			throw httpError(409, 'You can only seat an accepted member');
		}

		const targetUid = target.x_studio_user_id?.[0];
		// nothing to do — answer with the current rows rather than a write and a push
		if (target.x_studio_role === role) {
			return json({ ok: true, room: publicRoom(room), members: publicMembers(members) });
		}

		const changes = [{ id: target.id, role }];
		let demoted = null;

		if (role === 'player') {
			const capacity = playerCapacity(room.x_studio_game_type, room.x_studio_max_players);
			const seated = members.filter(
				(m) => m.x_studio_status === 'accepted' && m.x_studio_role === 'player'
			);
			if (seated.length >= capacity) {
				// A full table can still take a substitution, but the host has to say who
				// loses the seat — picking for them would silently bump someone. The code
				// is what lets the lobby open its swap picker on a race it didn't predict.
				if (demoteMemberId == null) {
					throw httpError(409, 'No free seat — choose a player to swap out', 'no_seat');
				}
				demoted = seated.find((m) => m.id === Number(demoteMemberId));
				if (!demoted) throw httpError(409, 'That member is not holding a seat');
				if (demoted.id === target.id) throw httpError(400, 'Pick a different player to swap out');
				changes.push({ id: demoted.id, role: 'spectator' });
			}
		}

		await setRoles(members, changes);

		// The seat count is what initGame validates at start ("chess exactly 2"), so a
		// miscount here would only surface as a 409 the host can't act on.
		const nowSeated = members.filter(
			(m) => m.x_studio_status === 'accepted' && m.x_studio_role === 'player'
		).length;
		if (nowSeated > playerCapacity(room.x_studio_game_type, room.x_studio_max_players)) {
			throw httpError(500, 'Seating went over capacity');
		}

		await appendEvent(
			params.id,
			'system',
			{
				kind: 'role-changed',
				uid: targetUid,
				role,
				...(demoted ? { demotedUid: demoted.x_studio_user_id?.[0] } : {})
			},
			uid
		);

		// role lives on the member rows, which the state push doesn't carry — without
		// this the rest of the room keeps showing the old seating until their next poll
		await pushRoster(params.id, room, members);
		return json({ ok: true, room: publicRoom(room), members: publicMembers(members) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

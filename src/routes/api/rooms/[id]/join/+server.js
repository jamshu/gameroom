import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { MEMBER, getRoom, getMembers, parseState, writeState, appendEvent, pushRoster, isPrivate, allowedUids, seatOnAccept, jsonError, httpError } from '$lib/server/room.js';

export const prerender = false;

/**
 * Join a room: pending until the host accepts, EXCEPT in a private room, where
 * being on the guest list is the approval — the host already picked you.
 */
export async function POST({ params, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const room = await getRoom(params.id);
		if (room.x_studio_status === 'finished') throw httpError(409, 'Room is finished');
		// Above the marker-clear below on purpose: that one writes state, and a
		// stranger hammering a private room shouldn't get to mutate it every attempt.
		const priv = isPrivate(room);
		if (priv && !allowedUids(room).includes(uid)) {
			throw httpError(403, 'This room is private', 'private');
		}
		// Removed by the host. Their live session was already ejected by the coded 403
		// in judgeMembership — that marker is what made it terminal AND accurate. It is
		// not a ban, though: asking again clears it and puts them back in the queue for
		// the host to accept or reject, which is what makes "remove someone so a waiting
		// player can take the seat" a swap rather than a one-way door.
		const state = parseState(room);
		if (state?.banned?.includes(uid)) {
			state.banned = state.banned.filter((u) => u !== uid);
			await writeState(params.id, state);
		}
		const members = await getMembers(params.id);
		const mine = members.find((m) => m.x_studio_user_id?.[0] === uid);
		if (mine?.x_studio_status === 'accepted') return json({ ok: true, status: 'accepted' });
		if (mine?.x_studio_status === 'pending') return json({ ok: true, status: 'pending' });

		// In a private room the host approved you when they added you to the list, so
		// there is nothing left to wait for. seatOnAccept is the same rule the host's
		// Accept button applies, so a private room seats people identically.
		const vals = priv
			? { x_studio_status: 'accepted', x_studio_role: seatOnAccept(room, members) }
			: { x_studio_status: 'pending' };

		if (mine) {
			// rejoin after leave/reject
			await adminExecute(MEMBER, 'write', [[mine.id], vals]);
		} else {
			await adminExecute(MEMBER, 'create', [{
				x_name: String(uid),
				x_studio_room_id: Number(params.id),
				x_studio_user_id: uid,
				...vals
			}]);
		}
		await appendEvent(
			params.id,
			'system',
			priv ? { kind: 'member-accepted', uid, role: vals.x_studio_role } : { kind: 'join-request', uid },
			uid
		);
		// re-read rather than patching the rows in hand: a first-time join CREATED a
		// row, and only Odoo knows its id. Joins are rare enough to afford the read.
		await pushRoster(params.id, room, await getMembers(params.id));
		return json({ ok: true, status: priv ? 'accepted' : 'pending' });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

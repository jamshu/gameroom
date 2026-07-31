import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth.js';
import { getRoom, getMembers, publicRoom, publicMembers, isPrivate, allowedUids, jsonError, httpError } from '$lib/server/room.js';
import { isDoRoom } from '$lib/server/doflag.js';

export const prerender = false;

/**
 * Room detail + members. Any authenticated user may view a PUBLIC room, so they
 * can request to join.
 *
 * A private room is gated here too, not just in the browse list: this response
 * carries the whole roster with everyone's name, so leaving it open would mean a
 * shared URL still exposed the room and its guests to anyone logged in.
 */
export async function GET({ params, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const room = await getRoom(params.id);
		// The guest list is the single authority — no "…or they're already a member"
		// escape hatch, because striking someone off the list also drops their member
		// row (see the invites endpoint), so the two can never disagree.
		if (isPrivate(room) && !allowedUids(room).includes(uid)) {
			throw httpError(403, 'This room is private', 'private');
		}
		const members = await getMembers(params.id);
		const isHost = room.x_studio_host_id?.[0] === uid;
		const mine = members.find((m) => m.x_studio_user_id?.[0] === uid);
		return json({
			ok: true,
			room: publicRoom(room),
			members: publicMembers(members),
			me: mine ? { status: mine.x_studio_status, role: mine.x_studio_role } : null,
			isHost,
			// Whether this room is served by a Durable Object. The client opens a
			// socket only when it is true, which keeps ONE flag source feeding both
			// sides and stops them disagreeing about which transport is live.
			//
			// It also means every existing Playwright spec — none of which sets `do`
			// in its room-detail mock — stays on the HTTP path untouched. That
			// matters beyond convenience: playwright.config runs `vite dev`, whose
			// HMR-only upgrade handling would meet a real ws request in undefined
			// ways (a hang would time out the whole suite).
			//
			// Leaks "this room is DO-backed" to any authenticated viewer, since this
			// route uses requireUser rather than requireMember. That is fine — it is
			// a routing hint, not a capability; the real gate is requireMemberCached
			// inside ws-auth.
			do: isDoRoom(params.id)
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

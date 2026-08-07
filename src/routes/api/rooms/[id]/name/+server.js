import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import {
	ROOM,
	requireHost,
	getRoom,
	publicRoom,
	publicMembers,
	appendEvent,
	pushRoster,
	jsonError,
	httpError
} from '$lib/server/room.js';

export const prerender = false;

// Matches the create form's maxlength (see the room-name input on the dashboard).
// Enforced HERE and not only there: creation never grew a server-side cap, and a
// rename that trusts the client would be the second place a 10kB title gets in.
const NAME_MAX = 60;

/**
 * Host renames the room.
 *
 * No writeState and no version bump: `x_name` is an x_gameroom COLUMN, not part
 * of the state blob, so nothing about the game changes. But pushRoster is still
 * mandatory rather than a nicety — the Durable Object caches the room row and
 * hands it to every joining socket in its `welcome` frame, so without the push
 * it would keep serving the old name to new arrivals indefinitely.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, members } = await requireHost(cookies, params.id);
		const { name } = await request.json();
		const clean = String(name ?? '').trim();

		if (!clean) throw httpError(400, 'Room name is required');
		if (clean.length > NAME_MAX) throw httpError(400, `Room name is too long (max ${NAME_MAX})`);

		await adminExecute(ROOM, 'write', [[Number(params.id)], { x_name: clean }]);
		await appendEvent(params.id, 'system', { kind: 'room-renamed', name: clean }, uid);

		// echo the room back so the acting host's own header flips immediately
		// rather than a poll later — same trick as the host handover
		const room = await getRoom(params.id);
		await pushRoster(params.id, room, members);
		return json({ ok: true, room: publicRoom(room), members: publicMembers(members) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

import { json } from '@sveltejs/kit';
import {
	requireHost,
	setHost,
	getRoom,
	publicRoom,
	publicMembers,
	appendEvent,
	jsonError,
	httpError
} from '$lib/server/room.js';

export const prerender = false;

/**
 * Host hands the room to another member.
 *
 * Safe at any point in a game, unlike removing someone: host is a ROOM-level
 * role, so nothing about `game.players` — the frozen seat snapshot taken at
 * start — changes. The new host simply gains the start/rematch/game-type and
 * join-request controls.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, members } = await requireHost(cookies, params.id);
		const { uid: targetUid } = await request.json();
		const target = members.find((m) => m.x_studio_user_id?.[0] === Number(targetUid));

		if (!target) throw httpError(404, 'That player is not in this room');
		if (target.x_studio_status !== 'accepted') {
			throw httpError(409, 'You can only pass host to an accepted member');
		}
		if (Number(targetUid) === uid) throw httpError(400, 'You are already the host');

		await setHost(params.id, targetUid);
		await appendEvent(params.id, 'system', { kind: 'host-changed', uid: Number(targetUid) }, uid);

		// echo the room back so the acting host's own view flips immediately rather
		// than a poll later — the same trick the game-type switch uses
		const room = await getRoom(params.id);
		return json({ ok: true, room: publicRoom(room), members: publicMembers(members) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

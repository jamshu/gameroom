import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { MEMBER, ROOM, requireMember, appendEvent, parseState, writeState, jsonError } from '$lib/server/room.js';

export const prerender = false;

/** Leave a room. Host leaving finishes the room (no host transfer v1). */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, member } = await requireMember(cookies, params.id);
		await adminExecute(MEMBER, 'write', [[member.id], { x_studio_status: 'left' }]);

		// drop from voice roster if present
		const state = parseState(room);
		if (state?.voice?.includes(uid)) {
			state.voice = state.voice.filter((u) => u !== uid);
			await writeState(params.id, state);
		}

		if (room.x_studio_host_id?.[0] === uid && room.x_studio_status !== 'finished') {
			await adminExecute(ROOM, 'write', [[Number(params.id)], { x_studio_status: 'finished' }]);
			await appendEvent(params.id, 'system', { kind: 'room-closed' }, uid);
		} else {
			await appendEvent(params.id, 'system', { kind: 'member-left', uid }, uid);
		}
		return json({ ok: true });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

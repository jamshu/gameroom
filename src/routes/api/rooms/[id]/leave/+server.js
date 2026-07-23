import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { MEMBER, ROOM, requireMember, appendEvent, parseState, writeState, deleteRoom, jsonError } from '$lib/server/room.js';

export const prerender = false;

/** Leave a room. Last member out → room deleted; host leaving → room finished. */
export async function POST({ params, cookies }) {
	try {
		const { uid, room, member, members } = await requireMember(cookies, params.id);
		await adminExecute(MEMBER, 'write', [[member.id], { x_studio_status: 'left' }]);

		// nobody active left → delete the whole room (abandoned)
		const activeRemain = members.some(
			(m) => m.id !== member.id && ['accepted', 'pending'].includes(m.x_studio_status)
		);
		if (!activeRemain) {
			await deleteRoom(params.id);
			return json({ ok: true, deleted: true });
		}

		// drop from voice roster if present
		const state = parseState(room);
		if (state?.voice?.includes(uid)) {
			state.voice = state.voice.filter((u) => u !== uid);
			await writeState(params.id, state);
		}

		if (room.x_studio_host_id === uid && room.x_studio_status !== 'finished') {
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

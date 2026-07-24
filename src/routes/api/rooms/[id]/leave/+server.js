import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import {
	MEMBER,
	requireMember,
	appendEvent,
	parseState,
	writeState,
	deleteRoom,
	pickSuccessorHost,
	setHost,
	resetRound,
	jsonError
} from '$lib/server/room.js';
import { gameSeatUids } from '$lib/server/gamelogic.js';

export const prerender = false;

/**
 * Leave a room. Last member out → room deleted.
 *
 * A leaving HOST now hands the room to the longest-standing remaining member
 * instead of closing it: the room, its chat and its voice call outlive whoever
 * happened to create it.
 */
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

		const state = parseState(room) || { v: 0, voice: [], game: null };
		const extraVals = {};
		let dirty = false;

		// drop from voice roster if present
		if (state.voice?.includes(uid)) {
			state.voice = state.voice.filter((u) => u !== uid);
			dirty = true;
		}

		/* A seated player walking out mid-game wedges it permanently: `game.players`
		   is a frozen snapshot taken at start and is never reconciled, so the turn
		   comes round to someone who isn't here — and there is no resign, skip or
		   turn timeout anywhere to recover from that. Drop the round and put the
		   room back in the lobby so the people still here can start another one. */
		if (state.game && room.x_studio_status === 'playing' && gameSeatUids(state.game).includes(uid)) {
			await resetRound(state, members.filter((m) => m.id !== member.id));
			extraVals.x_studio_status = 'lobby';
			dirty = true;
			await appendEvent(params.id, 'system', { kind: 'game-abandoned', uid }, uid);
		}

		// host leaving: pass the room on rather than closing it
		let newHostUid = null;
		if (room.x_studio_host_id?.[0] === uid) {
			newHostUid = pickSuccessorHost(members, uid);
			if (newHostUid) {
				await setHost(params.id, newHostUid);
				await appendEvent(params.id, 'system', { kind: 'host-changed', uid: newHostUid }, uid);
			}
		}

		// one write for the state + any status change, same as writeState's callers elsewhere
		if (dirty) await writeState(params.id, state, extraVals);
		await appendEvent(params.id, 'system', { kind: 'member-left', uid }, uid);
		return json({ ok: true, newHostUid });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

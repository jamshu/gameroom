import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import {
	requireHost,
	parseState,
	writeState,
	appendEvent,
	pushRoster,
	dropMember,
	isPrivate,
	allowedUids,
	setAllowed,
	jsonError,
	httpError
} from '$lib/server/room.js';

export const prerender = false;

/**
 * A private room's guest list — who can see it in browse and walk straight in.
 *
 * Host-only, both verbs. The list itself is not on `publicRoom`: that ships with
 * every roster push and every poll, and turning uids into names costs a
 * res.users read, which is exactly what this endpoint is for. A many2many reads
 * back as bare ids — unlike every many2one in this app, there's no [id, name].
 */
async function namesFor(uids) {
	if (!uids.length) return [];
	const rows = await adminExecute('res.users', 'read', [uids], { fields: ['name'] });
	return rows.map((r) => ({ uid: r.id, name: r.name }));
}

export async function GET({ params, cookies }) {
	try {
		const { room } = await requireHost(cookies, params.id);
		if (!isPrivate(room)) throw httpError(409, 'This room is not private');
		return json({ ok: true, allowed: await namesFor(allowedUids(room)) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

export async function POST({ params, request, cookies }) {
	try {
		const { uid, room, members } = await requireHost(cookies, params.id);
		if (!isPrivate(room)) throw httpError(409, 'This room is not private');

		const { uid: targetUid, action } = await request.json();
		const target = Number(targetUid);
		if (!Number.isInteger(target) || target <= 0) throw httpError(400, 'Invalid user');
		if (!['add', 'remove'].includes(action)) throw httpError(400, 'Invalid action');

		const current = allowedUids(room);

		if (action === 'add') {
			// idempotent: re-adding somebody already listed is a no-op, not an error
			if (!current.includes(target)) {
				const next = [...current, target];
				await setAllowed(params.id, next);
				room.x_studio_allowed_user_ids = next;
			}
			return json({ ok: true, allowed: await namesFor(allowedUids(room)) });
		}

		// The host is on their own list so the room shows in their own browse page;
		// striking themselves off would hide it from them.
		if (target === room.x_studio_host_id?.[0]) {
			throw httpError(400, 'You cannot remove yourself from your own room');
		}

		const next = current.filter((u) => u !== target);

		// Off the list means out of the room. Keeping the two in step is what lets
		// every other gate trust the list alone — otherwise a member who is no longer
		// invited keeps polling happily while the browse list pretends they're gone.
		const row = members.find(
			(m) => m.x_studio_user_id?.[0] === target && ['accepted', 'pending'].includes(m.x_studio_status)
		);
		if (row) {
			const state = parseState(room) || { v: 0, voice: [], game: null };
			await dropMember(row, state);
			// one ROOM write for the guest list AND the state, per writeState's extraVals
			await writeState(params.id, state, { x_studio_allowed_user_ids: [[6, 0, next]] });
			room.x_studio_allowed_user_ids = next;
			await appendEvent(params.id, 'system', { kind: 'member-removed', uid: target }, uid);
			await pushRoster(params.id, room, members);
		} else {
			// invited but never joined — nothing to announce, nobody's roster changes
			await setAllowed(params.id, next);
			room.x_studio_allowed_user_ids = next;
		}

		return json({ ok: true, allowed: await namesFor(next) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

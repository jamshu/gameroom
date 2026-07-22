import { json } from '@sveltejs/kit';
import { requireMember, appendEvent, parseState, jsonError, httpError } from '$lib/server/room.js';

export const prerender = false;

const KINDS = ['offer', 'answer', 'ice', 'bye'];

/** WebRTC signaling: relayed privately to `toUid` via the poll's target filter. */
export async function POST({ params, request, cookies }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		const { toUid, kind, data } = await request.json();
		if (!KINDS.includes(kind)) throw httpError(400, 'Invalid signal kind');
		const target = Number(toUid);
		if (!target) throw httpError(400, 'toUid required');

		const voice = parseState(room)?.voice || [];
		if (kind !== 'bye' && !voice.includes(uid)) throw httpError(403, 'Join voice first');

		const id = await appendEvent(params.id, 'signal', { kind, data }, uid, target);
		return json({ ok: true, id });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

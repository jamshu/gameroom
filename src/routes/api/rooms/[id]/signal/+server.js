import { json } from '@sveltejs/kit';
import { requireMemberCached, appendEvent, parseState, jsonError, httpError } from '$lib/server/room.js';

export const prerender = false;

const KINDS = ['offer', 'answer', 'ice', 'bye'];

/** WebRTC signaling: relayed privately to `toUid` via the poll's target filter. */
export async function POST({ params, request, cookies }) {
	try {
		// High cadence — a mesh fires many ICE frames per second, and the video-call
		// room multiplies that across up to 6 peers. The uncached requireMember does
		// two Odoo reads per call and rate-limits the whole app (429, same as the
		// carrom aim cursor found); the cached path serves membership from the 750ms
		// cache. State overlay stays on: the voice gate reads `voice`, which lives in
		// the (DO-fresh) state blob.
		const { uid, room } = await requireMemberCached(cookies, params.id);
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

import { json } from '@sveltejs/kit';
import { requireMember, parseState, writeState, appendEvent, jsonError, httpError } from '$lib/server/room.js';
import { stateView } from '$lib/server/gamelogic.js';

export const prerender = false;

const VOICE_CAP = 8; // WebRTC mesh degrades beyond this

export async function POST({ params, request, cookies }) {
	try {
		const { uid, room } = await requireMember(cookies, params.id);
		const { action } = await request.json();
		const state = parseState(room) || { v: 0, voice: [], game: null };
		state.voice = state.voice || [];

		if (action === 'join') {
			if (state.voice.includes(uid)) return json({ ok: true, voice: state.voice });
			if (state.voice.length >= VOICE_CAP) throw httpError(409, 'Voice is full — text chat only');
			state.voice.push(uid);
		} else if (action === 'leave') {
			if (!state.voice.includes(uid)) return json({ ok: true, voice: state.voice });
			state.voice = state.voice.filter((u) => u !== uid);
		} else {
			throw httpError(400, 'Invalid action');
		}

		await writeState(params.id, state);
		await appendEvent(params.id, 'system', { kind: `voice-${action}`, uid }, uid);
		return json({ ok: true, voice: state.voice, state: stateView(state, uid) });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

import { json } from '@sveltejs/kit';
import { requireMember, appendEvent, jsonError } from '$lib/server/room.js';

export const prerender = false;

export async function POST({ params, request, cookies }) {
	try {
		const { uid } = await requireMember(cookies, params.id);
		const { text } = await request.json();
		const trimmed = String(text || '').trim().slice(0, 2000);
		if (!trimmed) return json({ ok: false, error: 'Empty message' }, { status: 400 });
		const id = await appendEvent(params.id, 'chat', { text: trimmed }, uid);
		return json({ ok: true, id });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

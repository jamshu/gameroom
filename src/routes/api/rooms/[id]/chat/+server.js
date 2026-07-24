import { json } from '@sveltejs/kit';
import { requireMember, appendEvent, createRoomMedia, jsonError } from '$lib/server/room.js';
import { MEDIA_KINDS, MAX_BASE64, mimeAllowed } from '$lib/media.js';

export const prerender = false;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Send a chat message: text, media (photo / voice clip), or media with a caption.
 *
 * Media is stored and the event row written in ONE request on purpose — an
 * upload endpoint the client then had to follow with a post would strand an
 * attachment in Odoo every time that second call failed.
 */
export async function POST({ params, request, cookies }) {
	try {
		const { uid } = await requireMember(cookies, params.id);
		const { text, kind, dataBase64, mime, w, h, dur } = await request.json();
		const trimmed = String(text || '').trim().slice(0, 2000);

		if (kind != null) {
			if (!MEDIA_KINDS.has(kind) || !mimeAllowed(kind, mime)) {
				return json({ ok: false, error: 'Unsupported attachment' }, { status: 400 });
			}
			if (typeof dataBase64 !== 'string' || !dataBase64 || !BASE64.test(dataBase64)) {
				return json({ ok: false, error: 'No attachment data' }, { status: 400 });
			}
			if (dataBase64.length > MAX_BASE64) {
				return json({ ok: false, error: 'Attachment too large' }, { status: 413 });
			}
			const attId = await createRoomMedia(params.id, {
				name: kind === 'image' ? 'photo' : 'voice-message',
				mime,
				dataBase64
			});
			// The payload carries a REFERENCE only: appendEvent publishes it verbatim
			// over Ably (64KiB per message) and the poll refetches up to 200 of them.
			const payload = { kind, attId, mime, bytes: Math.round((dataBase64.length * 3) / 4) };
			if (kind === 'image') {
				payload.w = Number(w) || 0;
				payload.h = Number(h) || 0;
			} else {
				payload.dur = Number(dur) || 0;
			}
			if (trimmed) payload.text = trimmed;
			const id = await appendEvent(params.id, 'chat', payload, uid);
			return json({ ok: true, id, attId });
		}

		if (!trimmed) return json({ ok: false, error: 'Empty message' }, { status: 400 });
		const id = await appendEvent(params.id, 'chat', { text: trimmed }, uid);
		return json({ ok: true, id });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

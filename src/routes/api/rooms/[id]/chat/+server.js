import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { EVENT, requireMember, requireMemberCached, appendEvent, createRoomMedia, jsonError } from '$lib/server/room.js';
import { isDoRoom } from '$lib/server/doflag.js';
import { doOp } from '$lib/server/dostub.js';
import { MEDIA_KINDS, MAX_BASE64, mimeAllowed } from '$lib/media.js';

export const prerender = false;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PAGE_MAX = 100;

/**
 * A page of chat history, older than `?before=<id>`, oldest-first.
 *
 * Chat used to have NO source of its own: it arrived only as a side effect of the
 * event replay a client gets when it opens a room with cursor 0. That coupling is
 * why the room had to re-download its whole event log just to show yesterday's
 * messages, and why the event cursor could never be persisted — doing so would
 * have left every reopened room with an empty chat panel.
 *
 * No per-uid filter, deliberately: chat is never targeted (only WebRTC signals
 * are), so every member is entitled to every message in their room.
 */
export async function GET({ params, url, cookies }) {
	try {
		await requireMemberCached(cookies, params.id, { state: false });
		const before = Number(url.searchParams.get('before')) || 0;
		const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), PAGE_MAX);

		if (isDoRoom(params.id)) {
			const res = await doOp(params.id, { op: 'chat', before, limit });
			// `owns` false means the object holds only what arrived since it woke —
			// Odoo is still the complete archive, so fall through to it rather than
			// answering with a truncated history.
			if (res?.ok && res.owns) {
				return json({
					ok: true,
					more: res.more,
					// The object speaks the EVENT shape ({id,type,senderUid,payload});
					// flatten to the MESSAGE shape the store's chat array holds, so both
					// branches of this endpoint answer identically.
					messages: res.messages.map((m) => ({ id: m.id, senderUid: m.senderUid, ...m.payload }))
				});
			}
		}

		const domain = [
			['x_studio_room_id', '=', Number(params.id)],
			['x_studio_type', '=', 'chat']
		];
		if (before) domain.push(['id', '<', before]);
		const rows = await adminExecute(EVENT, 'search_read', [
			domain,
			['x_studio_payload', 'x_studio_sender_uid', 'x_studio_seq']
		], { order: 'id desc', limit: limit + 1 });

		const more = rows.length > limit;
		const page = (more ? rows.slice(0, limit) : rows).reverse();
		return json({
			ok: true,
			more,
			messages: page.map((r) => {
				let payload = {};
				try {
					payload = JSON.parse(r.x_studio_payload || '{}');
				} catch {
					/* one malformed row must not fail the whole page */
				}
				// Same shape the poll envelope and the store's ingest() use.
				return { id: r.x_studio_seq || r.id, senderUid: r.x_studio_sender_uid || 0, ...payload };
			})
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

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

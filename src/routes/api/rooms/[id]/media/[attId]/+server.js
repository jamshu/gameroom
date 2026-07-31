import { json } from '@sveltejs/kit';
import { requireMemberCached, readRoomMedia, jsonError } from '$lib/server/room.js';
import { IMAGE_MIMES, AUDIO_MIMES, parseRange, b64ToBytes } from '$lib/media.js';

export const prerender = false;

/**
 * Serve one chat attachment to a member of its room.
 *
 * Two guards, both needed: the membership check says the caller belongs HERE,
 * and `readRoomMedia` says the attachment does too — without the second, the id
 * in the URL would address every attachment in the Odoo database.
 *
 * Read-only, so it uses the CACHED membership path: opening a room with a dozen
 * photos in scrollback fires a dozen of these at once, and the uncached path
 * would cost 2 extra Odoo calls each — straight into the ~1 req/s rate limit
 * the whole room shares (see the budget note in stores/room.js).
 *
 * Byte ranges are honoured because iOS Safari REQUIRES them for <audio>: its
 * media loader opens with a `Range: bytes=0-1` probe and refuses to play a
 * source that answers 200 instead of 206. That's why voice notes played on
 * desktop but not on an iPhone, while images — which never use Range — worked
 * on both. The bytes are already fully in memory, so this is buffer slicing,
 * not streaming.
 */
export async function GET({ params, cookies, request }) {
	try {
		await requireMemberCached(cookies, params.id);
		const att = await readRoomMedia(params.id, params.attId);
		if (!att?.raw) return json({ ok: false, error: 'Not found' }, { status: 404 });

		// Whitelisted on the way OUT as well as in: serving an arbitrary stored
		// content type from our own origin is how an upload becomes stored XSS.
		const mime = String(att.mimetype || '');
		if (!IMAGE_MIMES.has(mime) && !AUDIO_MIMES.has(mime)) {
			return json({ ok: false, error: 'Not found' }, { status: 404 });
		}

		// Uint8Array, not Buffer — see b64ToBytes. `.subarray()`, `.length` and
		// `new Response(bytes)` all behave identically, so nothing below changes.
		const buf = b64ToBytes(att.raw);
		const headers = {
			'Content-Type': mime,
			'X-Content-Type-Options': 'nosniff',
			'Accept-Ranges': 'bytes',
			// attachment ids are immutable, so this can be cached hard
			'Cache-Control': 'private, max-age=86400'
		};

		const range = parseRange(request.headers.get('range'), buf.length);
		if (range === 'unsatisfiable') {
			return new Response(null, {
				status: 416,
				headers: { ...headers, 'Content-Range': `bytes */${buf.length}`, 'Content-Length': '0' }
			});
		}
		if (range) {
			const slice = buf.subarray(range.start, range.end + 1);
			return new Response(slice, {
				status: 206,
				headers: {
					...headers,
					'Content-Range': `bytes ${range.start}-${range.end}/${buf.length}`,
					'Content-Length': String(slice.length)
				}
			});
		}

		return new Response(buf, {
			headers: { ...headers, 'Content-Length': String(buf.length) }
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

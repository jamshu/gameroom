import { json } from '@sveltejs/kit';
import { requireMemberCached, readRoomMedia, jsonError } from '$lib/server/room.js';
import { IMAGE_MIMES, AUDIO_MIMES } from '$lib/media.js';

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
 */
export async function GET({ params, cookies }) {
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

		return new Response(Buffer.from(att.raw, 'base64'), {
			headers: {
				'Content-Type': mime,
				'X-Content-Type-Options': 'nosniff',
				// attachment ids are immutable, so this can be cached hard
				'Cache-Control': 'private, max-age=86400'
			}
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

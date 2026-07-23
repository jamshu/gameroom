import { adminExecute } from '$lib/server/odoo.js';

export const prerender = false;

const TRANSPARENT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

/** Serve a player's avatar (from x_player, keyed by client uuid). Public, cached. */
export async function GET({ params }) {
	try {
		const [p] = await adminExecute('x_player', 'search_read', [
			[['x_studio_uid', '=', params.uid]],
			['x_studio_avatar']
		]);
		const b64 = p?.x_studio_avatar;
		const body = b64 ? Buffer.from(b64, 'base64') : TRANSPARENT_PNG;
		return new Response(body, {
			headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' }
		});
	} catch {
		return new Response(TRANSPARENT_PNG, {
			status: 200,
			headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }
		});
	}
}

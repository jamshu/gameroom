import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';

export const prerender = false;

const TRANSPARENT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

/** Serve a user's avatar thumbnail through the proxy (cached client-side). */
export async function GET({ params, cookies }) {
	try {
		await requireUser(cookies);
		const uid = Number(params.uid);
		const [u] = await adminExecute('res.users', 'read', [[uid]], { fields: ['image_128'] });
		const b64 = u?.image_128;
		const body = b64 ? Buffer.from(b64, 'base64') : TRANSPARENT_PNG;
		return new Response(body, {
			headers: {
				// Odoo images are usually png/jpeg; browsers sniff fine from bytes
				'Content-Type': 'image/png',
				'Cache-Control': 'private, max-age=3600'
			}
		});
	} catch {
		return new Response(TRANSPARENT_PNG, {
			status: 200,
			headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }
		});
	}
}

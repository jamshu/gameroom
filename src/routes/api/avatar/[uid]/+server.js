import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { b64ToBytes } from '$lib/media.js';

export const prerender = false;

// Module scope, so this decode runs at ISOLATE STARTUP rather than per request —
// which is exactly why it must not depend on `Buffer`. On a Workers runtime a
// failure here would break the module import, taking out the route entirely
// rather than degrading one response.
const TRANSPARENT_PNG = b64ToBytes(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
);

/** Serve a user's avatar thumbnail through the proxy (cached client-side). */
export async function GET({ params, cookies }) {
	try {
		await requireUser(cookies);
		const uid = Number(params.uid);
		const [u] = await adminExecute('res.users', 'read', [[uid]], { fields: ['image_128'] });
		const b64 = u?.image_128;
		const body = b64 ? b64ToBytes(b64) : TRANSPARENT_PNG;
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

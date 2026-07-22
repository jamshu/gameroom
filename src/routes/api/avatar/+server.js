import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';

export const prerender = false;

/** Upload own avatar (client resizes to ≤512px before base64-ing). */
export async function POST({ request, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const { dataBase64 } = await request.json();
		if (!dataBase64 || typeof dataBase64 !== 'string') {
			return json({ ok: false, error: 'No image data' }, { status: 400 });
		}
		if (dataBase64.length > 1_500_000) {
			return json({ ok: false, error: 'Image too large' }, { status: 413 });
		}
		// Native Odoo avatar field on the user; admin write guarded to own uid.
		await adminExecute('res.users', 'write', [[uid], { image_1920: dataBase64 }]);
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Upload failed' }, { status: e?.status || 500 });
	}
}

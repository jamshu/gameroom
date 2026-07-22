import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';

export const prerender = false;

/** Update own display name. */
export async function POST({ request, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const { name } = await request.json();
		const trimmed = String(name || '').trim();
		if (!trimmed) return json({ ok: false, error: 'Name is required' }, { status: 400 });
		await adminExecute('res.users', 'write', [[uid], { name: trimmed.slice(0, 80) }]);
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Update failed' }, { status: e?.status || 500 });
	}
}

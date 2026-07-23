import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { setUidCookie } from '$lib/server/session.js';

export const prerender = false;

/**
 * Create/update a local player profile. The uuid is client-generated and comes
 * in the body (the first save happens before any cookie exists); we mirror
 * name+avatar into x_player so other players' rosters can show them, and set the
 * gr_uid cookie so subsequent requests are identified.
 */
export async function POST({ request, cookies }) {
	try {
		const { uid, name, avatar } = await request.json();
		const id = String(uid || '').trim();
		const trimmed = String(name || '').trim();
		if (!id || !trimmed) return json({ ok: false, error: 'Name is required' }, { status: 400 });
		if (avatar && (typeof avatar !== 'string' || avatar.length > 1_500_000)) {
			return json({ ok: false, error: 'Avatar too large' }, { status: 413 });
		}

		const vals = { x_studio_name: trimmed.slice(0, 80) };
		if (avatar) vals.x_studio_avatar = avatar;
		const [existing] = await adminExecute('x_player', 'search', [[['x_studio_uid', '=', id]]]);
		if (existing) await adminExecute('x_player', 'write', [[existing], vals]);
		else await adminExecute('x_player', 'create', [{ x_studio_uid: id, ...vals }]);

		setUidCookie(cookies, id);
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Update failed' }, { status: e?.status || 500 });
	}
}

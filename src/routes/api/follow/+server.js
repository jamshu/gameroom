import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { jsonError } from '$lib/server/room.js';

export const prerender = false;

const FOLLOWING = 'x_studio_following_ids'; // self m2m on res.users: users I follow

/** Who the caller follows: { ok, following: number[] } */
export async function GET({ cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const [u] = await adminExecute('res.users', 'read', [[uid]], { fields: [FOLLOWING] });
		return json({ ok: true, following: u?.[FOLLOWING] ?? [] });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

/** Follow / unfollow one user. Body: { targetUid, action: 'follow'|'unfollow' }. */
export async function POST({ request, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const { targetUid, action } = (await request.json()) ?? {};
		const t = Number(targetUid);
		if (!Number.isInteger(t) || t === uid) {
			return json({ ok: false, error: 'Invalid user' }, { status: 400 });
		}
		// Odoo m2m commands: [[4,id]] link, [[3,id]] unlink
		const cmd = action === 'unfollow' ? [[3, t]] : [[4, t]];
		await adminExecute('res.users', 'write', [[uid], { [FOLLOWING]: cmd }]);
		return json({ ok: true });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

import { json } from '@sveltejs/kit';
import { adminExecute, destroySession } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { purgeUserRooms } from '$lib/server/room.js';
import {
	clearSessionCookie,
	clearContextCookie,
	clearUserCookie
} from '$lib/server/session.js';

export const prerender = false;

/** Self-delete: purge the caller's rooms/memberships, unlink res.users, drop session. */
export async function POST({ request, cookies }) {
	try {
		const { uid, sid } = await requireUser(cookies);
		const { confirm } = (await request.json()) ?? {};
		if (confirm !== 'DELETE') {
			return json({ ok: false, error: 'Type DELETE to confirm' }, { status: 400 });
		}
		if (uid <= 2) {
			// guard base/admin users
			return json({ ok: false, error: 'This account cannot be deleted' }, { status: 403 });
		}

		await purgeUserRooms(uid);
		await adminExecute('res.users', 'unlink', [[uid]]);

		if (sid) await destroySession(sid).catch(() => {});
		clearSessionCookie(cookies);
		clearContextCookie(cookies);
		clearUserCookie(cookies);
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Delete failed' }, { status: e?.status || 500 });
	}
}

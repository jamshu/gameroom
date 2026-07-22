import { json } from '@sveltejs/kit';
import { sessionInfo, buildSessionContext } from '$lib/server/odoo.js';
import { getSession, clearSessionCookie, setContextCookie, refreshSessionCookie } from '$lib/server/session.js';

export const prerender = false;

export async function GET({ cookies }) {
	const sid = getSession(cookies);
	if (!sid) return json({ ok: false }, { status: 401 });
	try {
		const { result: info, sessionId } = await sessionInfo(sid);
		// Keep the cookie in sync with any rotated id + slide the 30-day expiry.
		refreshSessionCookie(cookies, sessionId, sid);
		setContextCookie(cookies, buildSessionContext(info));
		return json({ ok: true, user: { uid: info.uid, name: info.name, login: info.username } });
	} catch {
		clearSessionCookie(cookies);
		return json({ ok: false }, { status: 401 });
	}
}

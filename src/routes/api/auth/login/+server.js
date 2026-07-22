import { json } from '@sveltejs/kit';
import { assertConfigured, authenticateUser, buildSessionContext, normalizeLogin } from '$lib/server/odoo.js';
import { setSessionCookie, setContextCookie, setUserCookie } from '$lib/server/session.js';

export const prerender = false;

export async function POST({ request, cookies }) {
	try {
		assertConfigured();
		const { login, password } = await request.json();
		if (!login || !password) {
			return json({ ok: false, error: 'Login and password are required' }, { status: 400 });
		}

		const { sessionId, info } = await authenticateUser(normalizeLogin(login).login, password);
		const user = { uid: info.uid, name: info.name, login: info.username };
		setSessionCookie(cookies, sessionId);
		setContextCookie(cookies, buildSessionContext(info));
		setUserCookie(cookies, user);

		return json({ ok: true, user });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Login failed' }, { status: e?.status || 401 });
	}
}

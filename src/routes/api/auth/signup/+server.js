import { json } from '@sveltejs/kit';
import { assertConfigured, createUser, authenticateUser, buildSessionContext, normalizeLogin } from '$lib/server/odoo.js';
import { setSessionCookie, setContextCookie, setUserCookie } from '$lib/server/session.js';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?[0-9][0-9\s-]{6,14}$/;

export async function POST({ request, cookies }) {
	try {
		assertConfigured();
		const { name, login, password } = await request.json();
		const trimmedLogin = String(login || '').trim();
		if (!name || !trimmedLogin || !password) {
			return json({ ok: false, error: 'Name, email/mobile and password are required' }, { status: 400 });
		}
		if (!EMAIL_RE.test(trimmedLogin) && !MOBILE_RE.test(trimmedLogin)) {
			return json({ ok: false, error: 'Enter a valid email address or mobile number' }, { status: 400 });
		}
		if (String(password).length < 6) {
			return json({ ok: false, error: 'Password must be at least 6 characters' }, { status: 400 });
		}

		await createUser({ name: String(name).trim(), login: trimmedLogin, password });

		const { sessionId, info } = await authenticateUser(normalizeLogin(trimmedLogin).login, password);
		const user = { uid: info.uid, name: info.name, login: info.username };
		setSessionCookie(cookies, sessionId);
		setContextCookie(cookies, buildSessionContext(info));
		setUserCookie(cookies, user);

		return json({ ok: true, user });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Sign up failed' }, { status: e?.status || 500 });
	}
}

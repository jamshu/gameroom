import { json } from '@sveltejs/kit';
import { assertConfigured, authenticateUser, buildSessionContext, normalizeLogin } from '$lib/server/odoo.js';
import { setSessionCookie, setContextCookie, setUserCookie } from '$lib/server/session.js';
import { readPremium } from '$lib/server/premium.js';

export const prerender = false;

export async function POST({ request, cookies }) {
	try {
		assertConfigured();
		const { login, password } = await request.json();
		if (!login || !password) {
			return json({ ok: false, error: 'Login and password are required' }, { status: 400 });
		}

		const { sessionId, info } = await authenticateUser(normalizeLogin(login).login, password);
		// Session-info carries no custom fields, so the paid-tier flag needs its own
		// read. Doing it here (rather than per request) is what makes logging out and
		// back in the instant way to pick up a tier change — see PREMIUM_TTL_MS.
		const user = {
			uid: info.uid,
			name: info.name,
			login: info.username,
			premium: await readPremium(info.uid),
			premiumAt: Date.now()
		};
		setSessionCookie(cookies, sessionId);
		setContextCookie(cookies, buildSessionContext(info));
		setUserCookie(cookies, user);

		return json({ ok: true, user });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Login failed' }, { status: e?.status || 401 });
	}
}

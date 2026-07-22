import { json } from '@sveltejs/kit';
import { sessionInfo, buildSessionContext } from '$lib/server/odoo.js';
import {
	getSession,
	getContext,
	getUserCookie,
	setContextCookie,
	setUserCookie,
	refreshSessionCookie,
	slideIdentityCookies
} from '$lib/server/session.js';

export const prerender = false;

/**
 * Who am I?
 *
 * Odoo expires its own web sessions well before our 30-day cookie, and this
 * endpoint is polled by the keepalive every 10 minutes — so treating a dead
 * Odoo session as "logged out" is what used to sign people out mid-game after
 * an hour or two. Odoo is now only consulted to *refresh* the identity: if it
 * answers we take the fresh copy, and if it doesn't we fall back to the
 * identity cookie and slide the window forward. Only a genuinely absent
 * identity is a 401.
 */
export async function GET({ cookies }) {
	const sid = getSession(cookies);
	const cached = getUserCookie(cookies);
	const ctx = getContext(cookies);

	if (!sid && !cached) return json({ ok: false }, { status: 401 });

	try {
		const { result: info, sessionId } = await sessionInfo(sid);
		const user = { uid: info.uid, name: info.name, login: info.username };
		// Odoo is alive: sync the rotated id and take its copy as the truth.
		refreshSessionCookie(cookies, sessionId, sid);
		setContextCookie(cookies, buildSessionContext(info));
		setUserCookie(cookies, user);
		return json({ ok: true, user });
	} catch {
		// Odoo session gone (or Odoo briefly unreachable) — stay signed in.
		const user = cached || (ctx?.uid ? { uid: ctx.uid, name: '', login: '' } : null);
		if (!user) return json({ ok: false }, { status: 401 });
		slideIdentityCookies(cookies, ctx, user);
		return json({ ok: true, user });
	}
}

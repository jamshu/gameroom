import { json } from '@sveltejs/kit';
import { sessionInfo, buildSessionContext } from '$lib/server/odoo.js';
import {
	getSession,
	getContext,
	getUserCookie,
	setContextCookie,
	setUserCookie,
	refreshSessionCookie,
	slideIdentityCookies,
	PREMIUM_TTL_MS
} from '$lib/server/session.js';
import { readPremium } from '$lib/server/premium.js';

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
		// Premium is NOT in session-info, so it can only come from the cookie or a
		// separate res.users read. Carrying the cached value forward is mandatory:
		// this endpoint rebuilds `user` from scratch and re-writes the cookie every
		// 10 minutes, so anything not merged here is erased. Re-read only once the
		// cached copy is older than the TTL.
		const fresh = cached?.premiumAt && Date.now() - cached.premiumAt < PREMIUM_TTL_MS;
		const user = {
			uid: info.uid,
			name: info.name,
			login: info.username,
			premium: fresh ? !!cached.premium : await readPremium(info.uid),
			premiumAt: fresh ? cached.premiumAt : Date.now()
		};
		// Odoo is alive: sync the rotated id and take its copy as the truth.
		refreshSessionCookie(cookies, sessionId, sid);
		setContextCookie(cookies, buildSessionContext(info));
		setUserCookie(cookies, user);
		return json({ ok: true, user });
	} catch {
		// Odoo session gone (or Odoo briefly unreachable) — stay signed in. `cached`
		// still carries premium, so the flag survives an outage. The ctx-only
		// fallback below can't: it has no identity beyond the uid, so such a user
		// reads as non-premium until the next successful /me. Accepted degradation.
		const user = cached || (ctx?.uid ? { uid: ctx.uid, name: '', login: '' } : null);
		if (!user) return json({ ok: false }, { status: 401 });
		slideIdentityCookies(cookies, ctx, user);
		return json({ ok: true, user });
	}
}

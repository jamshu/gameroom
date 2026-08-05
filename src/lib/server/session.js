// httpOnly session cookie helpers. We store the Odoo web session id here; the
// browser never sees it from JavaScript. `secure` is handled automatically by
// SvelteKit (true over HTTPS, false on http://localhost in dev).
export const SESSION_COOKIE = 'app_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days — "stay logged in"

export function setSessionCookie(cookies, sessionId) {
	cookies.set(SESSION_COOKIE, sessionId, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: MAX_AGE
	});
}

export function clearSessionCookie(cookies) {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

// Keep the browser cookie in lockstep with Odoo. If Odoo rotated the session id
// (newId differs), store the new one; otherwise re-set the current id to slide the
// 30-day expiry forward on activity. No-op when there's no session.
export function refreshSessionCookie(cookies, newId, currentId) {
	const id = newId || currentId;
	if (id) setSessionCookie(cookies, id);
}

export function getSession(cookies) {
	return cookies.get(SESSION_COOKIE) || null;
}

// The user's Odoo call context ({ lang, tz, uid, allowed_company_ids }), captured
// at login so the proxy can pass it without a live session lookup. Not secret,
// but httpOnly keeps it tamper-resistant from page scripts.
export const CONTEXT_COOKIE = 'app_ctx';

export function setContextCookie(cookies, ctx) {
	cookies.set(CONTEXT_COOKIE, JSON.stringify(ctx), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: MAX_AGE
	});
}

export function clearContextCookie(cookies) {
	cookies.delete(CONTEXT_COOKIE, { path: '/' });
}

export function getContext(cookies) {
	const raw = cookies.get(CONTEXT_COOKIE);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// Display identity ({ uid, name, login, premium, premiumAt }). Kept so /me can
// answer without a live Odoo session — Odoo expires its own web sessions long
// before our 30 days, and that expiry used to bounce people to /login mid-game.
export const USER_COOKIE = 'app_user';

/**
 * How long a cached premium flag is trusted before we re-read res.users.
 *
 * The flag is not in session-info, so refreshing it costs a real Odoo call. /me
 * runs every 10 minutes per open tab and Odoo Online rate-limits at roughly
 * 1 req/s app-wide (see odoo.js), so a read per keepalive is not affordable —
 * one per user per 6 hours is. The cost is that a tier change can take up to
 * this long to show up; logging out and back in applies it immediately.
 */
export const PREMIUM_TTL_MS = 6 * 60 * 60 * 1000;

export function setUserCookie(cookies, user) {
	if (!user?.uid) return;
	// The key list is a whitelist, deliberately: it is the one place that decides
	// what lands in the cookie. Anything a caller forgets to pass is DROPPED, not
	// preserved — /me rebuilds `user` from scratch on every keepalive, so it has
	// to carry premium/premiumAt forward itself or a paying user silently loses
	// the flag ten minutes after logging in.
	const value = { uid: user.uid, name: user.name, login: user.login };
	if (user.premium) value.premium = true;
	if (user.premiumAt) value.premiumAt = user.premiumAt;
	cookies.set(USER_COOKIE, JSON.stringify(value), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: MAX_AGE
	});
}

export function clearUserCookie(cookies) {
	cookies.delete(USER_COOKIE, { path: '/' });
}

export function getUserCookie(cookies) {
	const raw = cookies.get(USER_COOKIE);
	if (!raw) return null;
	try {
		const u = JSON.parse(raw);
		return u?.uid ? u : null;
	} catch {
		return null;
	}
}

/** Re-set both identity cookies so the 30-day window slides forward on activity. */
export function slideIdentityCookies(cookies, ctx, user) {
	if (ctx?.uid) setContextCookie(cookies, ctx);
	if (user?.uid) setUserCookie(cookies, user);
}

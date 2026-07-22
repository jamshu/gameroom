// Resolve the authenticated user from request cookies. The app_ctx cookie carries
// the Odoo call context captured at login (/me refreshes it). Throws 401-tagged
// Errors; API routes convert to responses.
import {
	getSession,
	getContext,
	getUserCookie,
	setContextCookie,
	refreshSessionCookie
} from './session.js';
import { sessionInfo, buildSessionContext } from './odoo.js';

function unauthenticated() {
	const e = new Error('Not authenticated');
	e.status = 401;
	return e;
}

/**
 * Returns { uid, sid, ctx } where ctx = { lang, tz, uid, allowed_company_ids }.
 *
 * Identity comes from our own cookies; Odoo's web session is consulted only as
 * a last resort when they're missing (e.g. a session predating a deploy). Odoo
 * expires its sessions far sooner than our 30-day window, and callers only ever
 * use `uid` — no request should fail just because Odoo forgot the session.
 */
export async function requireUser(cookies) {
	const sid = getSession(cookies);
	let ctx = getContext(cookies);

	if (!ctx?.uid) {
		const cached = getUserCookie(cookies);
		if (cached?.uid) {
			ctx = { uid: cached.uid };
			setContextCookie(cookies, ctx);
		}
	}

	if (!ctx?.uid) {
		if (!sid) throw unauthenticated();
		const { result, sessionId } = await sessionInfo(sid);
		refreshSessionCookie(cookies, sessionId, sid);
		if (!result?.uid) throw unauthenticated();
		ctx = buildSessionContext(result);
		setContextCookie(cookies, ctx);
	}

	return { uid: ctx.uid, sid, ctx };
}

/** Wrap an API handler body: converts thrown {status} errors into JSON responses. */
export function errorJson(e) {
	return { error: e?.message || 'Request failed', status: e?.status || 500 };
}

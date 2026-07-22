// Resolve the authenticated user from request cookies. The app_ctx cookie carries
// the Odoo call context captured at login (/me refreshes it). Throws 401-tagged
// Errors; API routes convert to responses.
import { getSession, getContext, setContextCookie, refreshSessionCookie } from './session.js';
import { sessionInfo, buildSessionContext } from './odoo.js';

/**
 * Returns { uid, sid, ctx } where ctx = { lang, tz, uid, allowed_company_ids }.
 * Falls back to a live session lookup when the ctx cookie is missing (e.g.
 * sessions from before a deploy).
 */
export async function requireUser(cookies) {
	const sid = getSession(cookies);
	if (!sid) {
		const e = new Error('Not authenticated');
		e.status = 401;
		throw e;
	}
	let ctx = getContext(cookies);
	if (!ctx?.uid) {
		const { result, sessionId } = await sessionInfo(sid);
		refreshSessionCookie(cookies, sessionId, sid);
		if (!result?.uid) {
			const e = new Error('Not authenticated');
			e.status = 401;
			throw e;
		}
		ctx = buildSessionContext(result);
		setContextCookie(cookies, ctx);
	}
	return { uid: ctx.uid, sid, ctx };
}

/** Wrap an API handler body: converts thrown {status} errors into JSON responses. */
export function errorJson(e) {
	return { error: e?.message || 'Request failed', status: e?.status || 500 };
}

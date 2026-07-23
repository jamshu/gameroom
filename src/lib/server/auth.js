// Resolve the local player identity from the `gr_uid` cookie. No login, no Odoo
// session — the uuid is client-generated and trusted as-is (casual game). API
// routes convert the thrown 401 into a response; the client then shows the
// profile modal.
import { getUid } from './session.js';

function unauthenticated() {
	const e = new Error('No profile');
	e.status = 401;
	return e;
}

/** Returns { uid } — the caller's client uuid. Throws 401 if the cookie is absent. */
export async function requireUser(cookies) {
	const uid = getUid(cookies);
	if (!uid) throw unauthenticated();
	return { uid };
}

/** Wrap an API handler body: converts thrown {status} errors into JSON responses. */
export function errorJson(e) {
	return { error: e?.message || 'Request failed', status: e?.status || 500 };
}

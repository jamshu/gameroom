// Local identity: a client-generated uuid the browser sends in the `gr_uid`
// cookie. There is no login/session — this is an unauthenticated, disposable
// identity for a casual game (see the profile flow). Not httpOnly, since the
// client generates and owns it.
export const UID_COOKIE = 'gr_uid';
const MAX_AGE = 60 * 60 * 24 * 365; // a year — identity persists on the device

export function setUidCookie(cookies, uid) {
	if (!uid) return;
	cookies.set(UID_COOKIE, String(uid), { path: '/', httpOnly: false, sameSite: 'lax', maxAge: MAX_AGE });
}

export function getUid(cookies) {
	return cookies.get(UID_COOKIE) || null;
}

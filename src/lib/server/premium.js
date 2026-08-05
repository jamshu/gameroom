import { adminExecute } from './odoo.js';

/** Paid-tier boolean on res.users. Unlocks the chess engine hint. */
export const PREMIUM_FIELD = 'x_studio_is_premium';

/**
 * Is this user on the paid tier?
 *
 * Odoo's /web/session/get_session_info returns uid/name/username but never
 * custom fields, so the flag needs its own read — which is why callers cache it
 * in the identity cookie rather than asking on every request (see
 * PREMIUM_TTL_MS in session.js; Odoo Online rate-limits at roughly 1 req/s
 * app-wide).
 *
 * Users created before the field existed read NULL, so only an explicit `true`
 * counts. A failed read is "not premium", never an error: this runs inside the
 * login and keepalive paths, and an Odoo hiccup must not sign anyone out.
 */
export async function readPremium(uid) {
	try {
		const [rec] = await adminExecute('res.users', 'read', [[uid]], { fields: [PREMIUM_FIELD] });
		return rec?.[PREMIUM_FIELD] === true;
	} catch {
		return false;
	}
}

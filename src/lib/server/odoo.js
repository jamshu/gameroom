// Server-only Odoo helpers. Two auth contexts:
//   1. ADMIN (execute_kw with the API key) — signup provisioning AND all game/room
//      writes. Players are adversaries with real Odoo logins, so app models are
//      read-only for them at the Odoo ACL level; every mutation flows through
//      here after proxy-side authorization (membership / host / turn guards).
//   2. USER SESSION (web session cookie) — reads run as the logged-in user.
import { env } from '$env/dynamic/private';

const baseUrl = () => (env.ODOO_URL || '').replace(/\/$/, '');

export function assertConfigured() {
	if (!env.ODOO_URL || !env.ODOO_DB || !env.ODOO_USERNAME || !env.ODOO_API_KEY) {
		throw new Error('Odoo is not configured. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY.');
	}
}

/** Low-level JSON-RPC POST. Returns { result, setCookie[] }. */
async function rpc(path, params, cookie) {
	const headers = { 'Content-Type': 'application/json' };
	if (cookie) headers.cookie = cookie;
	const res = await fetch(`${baseUrl()}${path}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: Date.now() })
	});
	const setCookie =
		typeof res.headers.getSetCookie === 'function'
			? res.headers.getSetCookie()
			: res.headers.get('set-cookie')
				? [res.headers.get('set-cookie')]
				: [];
	const data = await res.json();
	if (data.error) {
		const err = data.error;
		const e = new Error(err.data?.message || err.message || 'Odoo error');
		// Odoo raises code 100 / SessionExpiredException when the session is dead.
		if (err.code === 100 || /SessionExpired|session expired/i.test(err.data?.name || err.message || '')) {
			e.status = 401;
		}
		throw e;
	}
	return { result: data.result, setCookie };
}

function parseSessionId(setCookieArr) {
	for (const c of setCookieArr || []) {
		const m = /^\s*session_id=([^;]+)/.exec(c);
		if (m) return m[1];
	}
	return null;
}

/* ------------------------------ admin context ----------------------------- */

let adminUid = null;
let _adminLoginPromise = null;

async function service(serviceName, method, args) {
	const res = await fetch(`${baseUrl()}/jsonrpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'call',
			params: { service: serviceName, method, args },
			id: Date.now()
		})
	});
	const data = await res.json();
	if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Odoo error');
	return data.result;
}

async function adminLogin() {
	if (adminUid) return adminUid;
	if (!_adminLoginPromise) {
		_adminLoginPromise = service('common', 'login', [env.ODOO_DB, env.ODOO_USERNAME, env.ODOO_API_KEY])
			.then((uid) => {
				if (!uid) throw new Error('Admin (API) authentication failed — check ODOO_USERNAME / ODOO_API_KEY');
				adminUid = uid;
				return uid;
			})
			.finally(() => {
				_adminLoginPromise = null;
			});
	}
	return _adminLoginPromise;
}

export async function adminExecute(model, method, args = [], kwargs = {}) {
	const uid = await adminLogin();
	return service('object', 'execute_kw', [env.ODOO_DB, uid, env.ODOO_API_KEY, model, method, args, kwargs]);
}

/** Create a res.users record in the shared/default company. login = email or mobile. */
export async function createUser({ name, login, password }) {
	const vals = { name: name || login, login, password };
	if (/@/.test(login)) vals.email = login;
	try {
		const gid = await adminExecute('ir.model.data', 'xmlid_to_res_id', ['base.group_user', false]);
		if (gid) vals.groups_id = [[6, 0, [gid]]];
	} catch {
		/* fall back to Odoo default groups */
	}

	let lastErr;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await adminExecute('res.users', 'create', [vals]);
		} catch (e) {
			if (/transaction.*aborted|deadlock|serialize|could not obtain/i.test(e.message)) {
				lastErr = e;
				await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
				continue;
			}
			if (/login.*already|already.*registered|duplicate|unique|in use/i.test(e.message)) {
				const er = new Error('That email / mobile is already registered');
				er.status = 409;
				throw er;
			}
			throw e;
		}
	}
	throw lastErr;
}

/* ------------------------------ user session ------------------------------ */

/** Authenticate a user; returns { sessionId, info }. */
export async function authenticateUser(login, password) {
	const { result, setCookie } = await rpc('/web/session/authenticate', {
		db: env.ODOO_DB,
		login,
		password
	});
	if (!result || !result.uid) {
		const e = new Error('Invalid login or password');
		e.status = 401;
		throw e;
	}
	const sessionId = parseSessionId(setCookie);
	if (!sessionId) throw new Error('Odoo did not return a session');
	return { sessionId, info: result };
}

export async function sessionInfo(sessionId) {
	const { result, setCookie } = await rpc('/web/session/get_session_info', {}, `session_id=${sessionId}`);
	if (!result || !result.uid) {
		const e = new Error('Session expired');
		e.status = 401;
		throw e;
	}
	// Odoo may rotate the session id; surface it so callers can re-sync the cookie.
	return { result, sessionId: parseSessionId(setCookie) };
}

/**
 * Build the Odoo call context from an authenticate / get_session_info result.
 * Shape: { lang, tz, uid, allowed_company_ids: [companyId] }.
 */
export function buildSessionContext(info) {
	const base = info?.user_context && typeof info.user_context === 'object' ? info.user_context : {};
	const ctx = { ...base };
	const current = info?.user_companies?.current_company ?? info?.company_id ?? null;
	if (current) ctx.allowed_company_ids = [current];
	if (info?.uid != null && ctx.uid == null) ctx.uid = info.uid;
	return ctx;
}

export async function sessionCallKw(sessionId, model, method, args = [], kwargs = {}) {
	const { result, setCookie } = await rpc(
		'/web/dataset/call_kw',
		{ model, method, args, kwargs },
		`session_id=${sessionId}`
	);
	// Odoo may rotate the session id; surface it so callers can re-sync the cookie.
	return { result, sessionId: parseSessionId(setCookie) };
}

export async function destroySession(sessionId) {
	try {
		await rpc('/web/session/destroy', {}, `session_id=${sessionId}`);
	} catch {
		/* ignore — cookie is cleared regardless */
	}
}

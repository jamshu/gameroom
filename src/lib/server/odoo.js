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

/**
 * Turn a non-2xx Odoo response into a typed, readable error.
 *
 * Odoo Online answers throttling and gateway failures with an HTML page, so
 * calling res.json() on it used to surface a raw
 * `Unexpected token '<', "<html><bod"...` — which says nothing about what went
 * wrong. `transient` marks the cases where Odoo rejected the request at the
 * HTTP layer, i.e. it never reached the ORM.
 */
async function transportError(res) {
	const body = await res.text().catch(() => '');
	const snippet = body
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 140);
	const label =
		res.status === 429
			? 'Odoo is rate limiting the app (HTTP 429)'
			: res.status >= 500
				? `Odoo is unavailable (HTTP ${res.status})`
				: `Odoo returned HTTP ${res.status}`;
	const e = new Error(snippet ? `${label}: ${snippet}` : label);
	e.httpStatus = res.status;
	e.transient = res.status === 429 || res.status >= 500;
	const ra = Number(res.headers.get('retry-after'));
	e.retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : null;
	return e;
}

/** Parse a JSON body, but report an HTML/garbage body as itself, not as a SyntaxError. */
async function parseJson(res) {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		const e = new Error(`Odoo returned a non-JSON response (HTTP ${res.status})`);
		e.httpStatus = res.status;
		e.transient = true;
		throw e;
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
	if (!res.ok) throw await transportError(res);
	const setCookie =
		typeof res.headers.getSetCookie === 'function'
			? res.headers.getSetCookie()
			: res.headers.get('set-cookie')
				? [res.headers.get('set-cookie')]
				: [];
	const data = await parseJson(res);
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
	if (!res.ok) throw await transportError(res);
	const data = await parseJson(res);
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

const IDEMPOTENT = new Set(['read', 'search', 'search_read', 'search_count', 'fields_get', 'name_get']);
const MAX_RETRIES = 2; // up to 3 attempts

/**
 * Retry policy, which turns on whether Odoo actually *ran* the request.
 *
 * - `transient` (HTTP 429/5xx, or an HTML body): Odoo rejected it at the front
 *   door and it never reached the ORM, so replaying is safe **even for writes**.
 *   This is the case that matters — Odoo Online throttles under load, and it
 *   used to fail a whole poll (or a chat send) with an opaque parse error.
 * - Anything else (a network blip, an ORM-level error): the write may already
 *   have applied, so only reads may be replayed. Retrying a `create` here would
 *   double-post a chat message.
 */
function retryableAfter(e, method, attempt) {
	if (attempt >= MAX_RETRIES) return null;
	const odooNeverRanIt = e?.transient === true;
	if (!odooNeverRanIt && !(e?.httpStatus == null && IDEMPOTENT.has(method))) return null;
	// honour Retry-After when Odoo sends one; otherwise exponential + jitter
	return e?.retryAfterMs ?? Math.round(250 * 2 ** attempt + Math.random() * 150);
}

export async function adminExecute(model, method, args = [], kwargs = {}) {
	const uid = await adminLogin();
	for (let attempt = 0; ; attempt++) {
		try {
			return await service('object', 'execute_kw', [
				env.ODOO_DB, uid, env.ODOO_API_KEY, model, method, args, kwargs
			]);
		} catch (e) {
			const wait = retryableAfter(e, method, attempt);
			if (wait == null) throw e;
			await new Promise((r) => setTimeout(r, wait));
		}
	}
}

/**
 * Odoo (19 SaaS) requires email-format logins. Mobile signups get a synthetic
 * internal email derived from the digits; the real number is kept in `phone`.
 * Login input is normalized the same way, so users keep typing their mobile.
 */
export function normalizeLogin(login) {
	const trimmed = String(login || '').trim();
	if (/@/.test(trimmed)) return { login: trimmed.toLowerCase(), phone: null };
	const digits = trimmed.replace(/[^0-9]/g, '');
	return { login: `m${digits}@mobile.gamerooms.local`, phone: trimmed };
}

/** Create a res.users record in the shared/default company. login = email or mobile. */
export async function createUser({ name, login, password }) {
	const norm = normalizeLogin(login);
	const vals = { name: name || login, login: norm.login, email: norm.login, password };
	if (norm.phone) vals.phone = norm.phone;
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

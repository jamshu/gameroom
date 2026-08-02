// Odoo admin JSON-RPC, as a factory that takes its config rather than reading
// $env.
//
// ISOMORPHIC BY CONTRACT — no `$lib`, no `$env`. The room Durable Object needs
// Odoo for hydration and write-behind, and wrangler bundles it outside the
// SvelteKit build where neither resolves. `check:noenv` enforces this.
//
// Only the ADMIN path lives here. Session/auth (createUser, authenticateUser,
// sessionInfo, …) stays in src/lib/server/odoo.js: the DO never touches it, and
// moving it would enlarge the blast radius for no gain.
//
// The retry policy below is hard-won and must not be duplicated — see the note
// on retryableAfter. src/lib/server/odoo.js delegates to this factory rather
// than keeping a second copy.

/**
 * Odoo Online answers throttling and gateway failures with an HTML page, so
 * calling res.json() on it surfaces `Unexpected token '<'` — which says nothing
 * about what went wrong. `transient` marks the cases where Odoo rejected the
 * request at the HTTP layer, i.e. it never reached the ORM.
 */
async function transportError(res) {
	const body = await res.text().catch(() => '');
	const snippet = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
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

/** Parse a JSON body, but report an HTML/garbage body as itself, not a SyntaxError. */
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

const IDEMPOTENT = new Set(['read', 'search', 'search_read', 'search_count', 'fields_get', 'name_get']);
const MAX_RETRIES = 2; // up to 3 attempts

/**
 * Retry policy, which turns on whether Odoo actually *ran* the request.
 *
 * - `transient` (HTTP 429/5xx, or an HTML body): Odoo rejected it at the front
 *   door and it never reached the ORM, so replaying is safe **even for writes**.
 *   This is the case that matters — Odoo Online throttles under load.
 * - Anything else (a network blip, an ORM-level error): the write may already
 *   have applied, so only reads may be replayed. Retrying a `create` here would
 *   double-post a chat message.
 */
function retryableAfter(e, method, attempt) {
	if (attempt >= MAX_RETRIES) return null;
	const odooNeverRanIt = e?.transient === true;
	if (!odooNeverRanIt && !(e?.httpStatus == null && IDEMPOTENT.has(method))) return null;
	return e?.retryAfterMs ?? Math.round(250 * 2 ** attempt + Math.random() * 150);
}

/**
 * Build an admin client bound to one Odoo instance.
 *
 * `stats` is shared with the caller so the Worker's existing X-Odoo-Throttled
 * header keeps counting the same numbers.
 */
export function createOdooAdmin({ url, db, username, apiKey, stats } = {}) {
	const baseUrl = () => String(url || '').replace(/\/$/, '');
	const counters = stats ?? { calls: 0, retries: 0, throttled: 0, failed: 0 };

	// Per-client, not module-scope: a Durable Object and the Worker are separate
	// isolates with separate lifetimes, and a shared login promise across them
	// would be a cross-instance leak waiting to happen.
	let adminUid = null;
	let loginPromise = null;

	function configured() {
		return !!(url && db && username && apiKey);
	}

	async function service(serviceName, method, args) {
		const res = await fetch(`${baseUrl()}/jsonrpc`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service: serviceName, method, args }, id: Date.now() })
		});
		if (!res.ok) throw await transportError(res);
		const data = await parseJson(res);
		if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Odoo error');
		return data.result;
	}

	async function login() {
		if (adminUid) return adminUid;
		if (!loginPromise) {
			loginPromise = service('common', 'login', [db, username, apiKey])
				.then((uid) => {
					if (!uid) throw new Error('Admin (API) authentication failed — check ODOO_USERNAME / ODOO_API_KEY');
					adminUid = uid;
					return uid;
				})
				.finally(() => { loginPromise = null; });
		}
		return loginPromise;
	}

	function log(event, fields) {
		try {
			console.log(JSON.stringify({ t: 'odoo', event, ...fields, ...counters }));
		} catch {
			/* instrumentation must never break a request */
		}
	}

	async function adminExecute(model, method, args = [], kwargs = {}) {
		const uid = await login();
		counters.calls++;
		for (let attempt = 0; ; attempt++) {
			try {
				return await service('object', 'execute_kw', [db, uid, apiKey, model, method, args, kwargs]);
			} catch (e) {
				if (e?.httpStatus === 429) counters.throttled++;
				const wait = retryableAfter(e, method, attempt);
				if (wait == null) {
					counters.failed++;
					log('give_up', { model, method, attempt, status: e?.httpStatus ?? null, msg: String(e?.message || '').slice(0, 120) });
					throw e;
				}
				counters.retries++;
				log('retry', { model, method, attempt, wait, status: e?.httpStatus ?? null });
				await new Promise((r) => setTimeout(r, wait));
			}
		}
	}

	return { adminExecute, configured, stats: counters };
}

// Thin fetch wrapper for the /api/* proxy. On 401 the caller is logged out —
// redirect (except when already checking auth).
import { goto } from '$app/navigation';
import { get } from 'svelte/store';
import { user } from '$lib/stores/auth.js';

// A request that never answers used to hang forever — there was no timeout on
// either side of the wire. That wedged the room's poll loop, which guards itself
// with an `inFlight` flag it only clears in a `finally`: one stuck request and
// every later "poll now" (including the reconcile a failed move fires) was
// dropped on the floor until the browser gave up on its own. These are ceilings,
// not targets. A poll may be cut short freely — it just runs again — so it gets
// the tighter one; a write is not safely repeatable, so it gets room to land.
export const WRITE_TIMEOUT_MS = 20000;
export const POLL_TIMEOUT_MS = 10000;

/**
 * `onMeta` is optional and exists only for the Stage 0 beacon: it hands back the
 * server's own X-Dur-Ms so a round trip can be split into server time vs
 * network. That split is the whole comparison for a platform migration — total
 * RTT alone can't tell a slow backend from a slow link. Nothing else uses it,
 * and it can never affect the request.
 */
export async function api(
	path,
	{ method = 'GET', body, redirectOn401 = true, timeoutMs = WRITE_TIMEOUT_MS, onMeta } = {}
) {
	const opts = { method, headers: {} };
	if (body !== undefined) {
		opts.headers['Content-Type'] = 'application/json';
		opts.body = JSON.stringify(body);
	}
	const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
	let timedOut = false;
	let timer = null;
	if (ctl && timeoutMs > 0) {
		opts.signal = ctl.signal;
		timer = setTimeout(() => {
			timedOut = true;
			ctl.abort();
		}, timeoutMs);
	}
	let res, data;
	try {
		res = await fetch(path, opts);
		data = await res.json().catch((e) => {
			// A body cut off mid-flight is a LOST RESPONSE and must fall through to
			// the offline path below. Only a genuinely non-JSON body gets the empty
			// object — the endpoints all answer JSON, so that's an error page.
			if (ctl?.signal.aborted) throw e;
			return {};
		});
	} catch {
		// fetch() rejects with a TypeError when the request never completed at all:
		// Safari words it 'Load failed', Chrome 'Failed to fetch'. Neither means
		// anything to a player, and — importantly — neither tells us whether the
		// server processed it. Our own abort lands here too and means the same
		// thing. Flagged so callers can re-poll and let the authoritative state
		// answer that, rather than resending blind.
		const err = new Error(
			timedOut
				? 'No answer from the server — that may not have gone through.'
				: 'Connection lost — that may not have gone through.'
		);
		err.offline = true;
		if (timedOut) err.timeout = true;
		throw err;
	} finally {
		clearTimeout(timer);
	}
	if (onMeta) {
		// Before the status checks on purpose — a 500 that took 9s is exactly the
		// datapoint worth having. Never allowed to affect the outcome.
		try {
			const ms = Number(res.headers.get('X-Dur-Ms'));
			onMeta({ serverMs: Number.isFinite(ms) ? ms : null });
		} catch {
			/* instrumentation is never load-bearing */
		}
	}
	if (res.status === 401 && redirectOn401) {
		// Holding a user means their session expired mid-play → send them to sign
		// in. With no user (a guest deep-linking in, before the auth gate settles)
		// /signup is the friendlier landing.
		goto(get(user) ? '/login' : '/signup');
		throw new Error('Not authenticated');
	}
	if (!res.ok || data.ok === false) {
		// carry status + server code so callers can tell terminal from transient
		const err = new Error(data.error || `Request failed (${res.status})`);
		err.status = res.status;
		if (data.code) err.code = data.code;
		throw err;
	}
	return data;
}

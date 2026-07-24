// Thin fetch wrapper for the /api/* proxy. On 401 the caller is logged out —
// redirect (except when already checking auth).
import { goto } from '$app/navigation';
import { get } from 'svelte/store';
import { user } from '$lib/stores/auth.js';

export async function api(path, { method = 'GET', body, redirectOn401 = true } = {}) {
	const opts = { method, headers: {} };
	if (body !== undefined) {
		opts.headers['Content-Type'] = 'application/json';
		opts.body = JSON.stringify(body);
	}
	const res = await fetch(path, opts);
	const data = await res.json().catch(() => ({}));
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

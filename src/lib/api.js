// Thin fetch wrapper for the /api/* proxy. On 401 the caller is logged out —
// redirect to /login (except when already checking auth).
import { goto } from '$app/navigation';

export async function api(path, { method = 'GET', body, redirectOn401 = true } = {}) {
	const opts = { method, headers: {} };
	if (body !== undefined) {
		opts.headers['Content-Type'] = 'application/json';
		opts.body = JSON.stringify(body);
	}
	const res = await fetch(path, opts);
	const data = await res.json().catch(() => ({}));
	if (res.status === 401 && redirectOn401) {
		goto('/login');
		throw new Error('Not authenticated');
	}
	if (!res.ok || data.ok === false) {
		throw new Error(data.error || `Request failed (${res.status})`);
	}
	return data;
}

import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Shared-secret gate for the endpoints only a Cron Trigger should reach.
 *
 * Returns a Response to send back when the caller is not the cron, or null when
 * it is. Factored out rather than copied a fourth time: this is the whole of the
 * authentication on routes that mutate every finished room in the database, and
 * a check that exists in four places is a check that gets fixed in three.
 *
 * Fails CLOSED on a missing secret. An unset CRON_SECRET with a permissive
 * default would leave the endpoint open to anyone who guessed the path.
 */
export function requireCronSecret(request, label) {
	const expected = env.CRON_SECRET;
	if (!expected) {
		console.error(`${label}: CRON_SECRET is not set — refusing to run`);
		return json({ ok: false, error: 'Not configured' }, { status: 503 });
	}
	// Constant-time-ish: compare lengths first, then every byte, so a timing
	// signal can't be used to walk the secret out one character at a time.
	const got = request.headers.get('x-cron-secret') || '';
	let diff = got.length ^ expected.length;
	for (let i = 0; i < got.length; i++) {
		diff |= got.charCodeAt(i) ^ expected.charCodeAt(i % expected.length);
	}
	// 404, not 401: a wrong secret shouldn't confirm the route exists.
	if (diff !== 0) return json({ ok: false, error: 'Not found' }, { status: 404 });
	return null;
}

import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { sweepAbandonedRooms } from '$lib/server/room.js';

export const prerender = false;

/**
 * Abandoned-room GC, driven by the Cron Trigger in wrangler.toml via
 * worker-entry.js.
 *
 * A route rather than a bare handler because the work needs Odoo credentials,
 * and those only reach app code through $env/dynamic/private during a request.
 *
 * The secret is not optional. This endpoint DELETES rooms, so an unauthenticated
 * caller could wipe every room whose members happen to be idle. A missing or
 * mismatched CRON_SECRET fails closed — better a cron that visibly does nothing
 * than an open destructive endpoint.
 */
export async function POST({ request }) {
	const expected = env.CRON_SECRET;
	if (!expected) {
		console.error('cron/sweep: CRON_SECRET is not set — refusing to run');
		return json({ ok: false, error: 'Not configured' }, { status: 503 });
	}
	// Constant-time-ish: compare lengths first, then every byte, so a timing
	// signal can't be used to walk the secret out one character at a time.
	const got = request.headers.get('x-cron-secret') || '';
	let diff = got.length ^ expected.length;
	for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i % expected.length);
	if (diff !== 0) return json({ ok: false, error: 'Not found' }, { status: 404 });

	const deleted = await sweepAbandonedRooms();
	return json({ ok: true, deleted });
}

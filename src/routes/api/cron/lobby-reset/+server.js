import { json } from '@sveltejs/kit';
import { requireCronSecret } from '$lib/server/cronauth.js';
import { resetFinishedRooms } from '$lib/server/room.js';

export const prerender = false;

/**
 * Return finished rooms to their lobby, driven by the Cron Trigger in
 * wrangler.toml via the generated `scheduled` handler (scripts/wrap-worker.mjs).
 *
 * A route rather than a bare handler for the same reason cron/sweep is one: the
 * work needs Odoo credentials, and those only reach app code through
 * $env/dynamic/private during a request.
 *
 * DELIBERATELY NOT /api/cron/sweep. That endpoint's body is guarded to a hard
 * `return 0` because automatic room DELETION was withdrawn; hanging this on it
 * would mean either un-guarding that or making one path mean two things. This
 * one only ever resets a room to lobby — nothing here can destroy anything.
 */
export async function POST({ request }) {
	const denied = requireCronSecret(request, 'cron/lobby-reset');
	if (denied) return denied;

	const reset = await resetFinishedRooms();
	return json({ ok: true, reset });
}

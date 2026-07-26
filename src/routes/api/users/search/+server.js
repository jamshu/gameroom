import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { jsonError } from '$lib/server/room.js';

export const prerender = false;

const MIN_CHARS = 2;
const LIMIT = 10;

/**
 * Find people to invite to a private room. The app has no other user directory —
 * names otherwise only ever reach a client via a room roster they're already in.
 *
 * Two chars minimum and a hard limit, both to keep this from being a bulk export
 * and because Odoo Online rate-limits per IP and the whole app shares that
 * budget; the client debounces on top (UserPicker.svelte).
 */
export async function GET({ url, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const q = url.searchParams.get('q')?.trim() || '';
		if (q.length < MIN_CHARS) return json({ ok: true, users: [] });

		const rows = await adminExecute('res.users', 'search_read', [
			// `share` excludes portal/public users — everyone who signs up through
			// this app is a base.group_user internal user (odoo.js createUser).
			[['name', 'ilike', q], ['active', '=', true], ['share', '=', false]],
			['name']
		], { limit: LIMIT });

		return json({
			ok: true,
			users: rows
				.filter((r) => r.id !== uid) // you're already in your own room
				.map((r) => ({ uid: r.id, name: r.name }))
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

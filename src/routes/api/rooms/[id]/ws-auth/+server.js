import { json } from '@sveltejs/kit';
import { requireMemberCached, jsonError } from '$lib/server/room.js';

export const prerender = false;

/**
 * Membership check for the WebSocket handshake.
 *
 * The upgrade itself cannot be answered from a SvelteKit route: SvelteKit runs
 * `add_cookies_to_headers` on the response OUTSIDE any try/catch, and a Response
 * returned by a Durable Object stub has immutable headers — so any request where
 * requireUser refreshes a cookie (auth.js does, when app_ctx is missing but
 * app_user is present) would throw and surface as an INTERMITTENT 500 on the
 * handshake. The generated worker wrapper intercepts the upgrade instead and
 * calls this route for the auth half.
 *
 * Reusing requireMemberCached verbatim keeps the coded 403s — `removed`,
 * `pending`, `not_member` — so the wrapper can map them to close codes the
 * client already treats as terminal, rather than letting it reconnect forever.
 *
 * Safe to be publicly reachable: it derives uid from the caller's own cookies
 * and returns nothing they don't already have.
 */
export async function GET({ params, cookies }) {
	try {
		const { uid, member } = await requireMemberCached(cookies, params.id);
		return json({ ok: true, uid, name: member?.x_studio_user_id?.[1] || '' });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

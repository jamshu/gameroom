// Stage 0 instrumentation. Added for one reason: the room's latency budget has
// never been measured, only reasoned about from the code, so every claim about
// where the time goes is currently unfalsifiable.
//
// A hook rather than per-route edits — this is the only place that sees every
// /api/* request, and it survives the move off Amplify unchanged. It adds two
// response headers and nothing else; no request is failed, delayed or altered.
import { odooStatsSnapshot } from '$lib/server/odoo.js';

// NOTE: cron does NOT live here. adapter-cloudflare's worker template exports
// only `fetch` — there is no SvelteKit hook for a scheduled event, so anything
// exported here for that purpose would never be called and would fail silently.
// The Cron Trigger is wired in worker-entry.js → POST /api/cron/sweep.

export async function handle({ event, resolve }) {
	// Prerendering runs this hook too. Only API traffic is interesting, and
	// mutating a prerendered asset's headers would be a side effect for nothing.
	if (!event.url.pathname.startsWith('/api/')) return resolve(event);

	const t0 = Date.now();
	const response = await resolve(event);
	try {
		response.headers.set('X-Dur-Ms', String(Date.now() - t0));
		// Cumulative for this isolate, not this request (see odoo.js). Useful as a
		// rate: if X-Odoo-Throttled climbs across successive responses, the shared
		// ~1 req/s Odoo budget is the thing being hit.
		const s = odooStatsSnapshot();
		response.headers.set('X-Odoo-Throttled', `${s.throttled}/${s.calls}`);
	} catch {
		/* a response with immutable headers must not become a 500 */
	}
	return response;
}

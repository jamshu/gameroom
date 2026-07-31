import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireUser } from '$lib/server/auth.js';
import { adminExecute } from '$lib/server/odoo.js';
import { jsonError } from '$lib/server/room.js';

export const prerender = false;

// Sink for the Stage 0 client beacon (src/lib/metrics.js), fired every 5 minutes
// per client plus once on pagehide.
//
// TWO sinks on purpose. A JSON log line is the cheap one, but it is only worth
// anything if someone can actually read the deployed app's logs — and if that
// tooling isn't reachable, Stage 0 silently produces nothing at all, which is
// the one outcome that makes the whole measurement pointless. So the numbers
// also go into Odoo's built-in `ir.logging`, which needs no Studio schema work
// and is readable from the Odoo UI (Settings → Technical → Logging, dev mode on;
// filter name = 'gameroom.metrics').
//
// Cost, stated plainly because this is instrumentation adding load to the very
// budget it measures: one Odoo create per client per 5 minutes. A 4-player room
// is ~0.013 req/s against a shared ~1 req/s — noise, but not zero. Set
// METRICS_SINK=off to drop to log-only.
//
// requireUser is the gate rather than requireMember: it does no I/O in the
// normal path (session cookie only), and the point is just to stop this being an
// open write-to-our-storage endpoint. A metric is not worth an Odoo read.
export async function POST({ request, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const body = await request.json().catch(() => ({}));
		// The client is not trusted to bound its own payload, and this is persisted.
		const safe = {};
		let n = 0;
		for (const [k, v] of Object.entries(body || {})) {
			if (n++ >= 40) break;
			if (typeof v === 'number' || v === null) safe[String(k).slice(0, 40)] = v;
		}
		const line = JSON.stringify({ t: 'clientmetrics', uid, ...safe });
		console.log(line);

		if (env.METRICS_SINK !== 'off') {
			// Best-effort, exactly like the realtime publishes: a metrics write must
			// never turn into a client-visible error. The log line above already
			// happened, so a failure here costs one sink, not the datapoint.
			try {
				await adminExecute('ir.logging', 'create', [{
					name: 'gameroom.metrics',
					type: 'server',
					level: 'INFO',
					// `line` is a char field in Odoo, not an int — pass a string.
					line: '0',
					func: `room:${safe.room ?? '?'}`,
					path: `uid:${uid}`,
					message: line
				}]);
			} catch (e) {
				console.error('metrics: ir.logging write failed:', e?.message);
			}
		}
		return json({ ok: true });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

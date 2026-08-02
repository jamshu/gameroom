// Post-build step: add a `scheduled` handler to the Worker.
//
// WHY THIS IS NOT JUST A FILE WE WROTE BY HAND:
// adapter-cloudflare's template (node_modules/@sveltejs/adapter-cloudflare/
// files/worker.js) exports ONLY `fetch` — there is no `scheduled` handler and no
// SvelteKit hook that receives one. A Cron Trigger declared in wrangler.toml
// would therefore fire into nothing, silently, and abandoned rooms would
// accumulate forever with no error anywhere to notice.
//
// The obvious fix — point wrangler's `main` at our own wrapper — does not work:
// the adapter reads `main` out of wrangler.toml and writes ITS worker to that
// path (index.js:58-59), clobbering the wrapper on every build. So the wrapper
// has to be applied AFTER the adapter has run. That is this script.
//
// The cron work needs Odoo credentials, which only reach app code through
// $env/dynamic/private during a request — outside one it is empty. So rather
// than reimplementing the Odoo client against the raw `env`, `scheduled`
// dispatches a synthetic request back through the same Worker, and the normal
// route runs with its normal env, imports and error handling.
// EXPECTED BUILD NOISE, so nobody chases it: `vite build` runs a workerd
// validation pass BEFORE this script executes, so at that moment _worker.js has
// no RoomDO export yet and workerd warns "a DurableObjectNamespace referenced
// the class RoomDO, but no such class is exported". It is resolved by the time
// anything runs — `wrangler deploy --dry-run` reports the binding correctly.
// Verify there, not in the vite output.
import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';

const DIR = '.svelte-kit/cloudflare';
const ENTRY = `${DIR}/_worker.js`;
const INNER = `${DIR}/_sk-worker.js`;
const MARKER = '/* gameroom:scheduled-wrapper */';

if (!existsSync(ENTRY)) {
	throw new Error(`${ENTRY} not found — run after \`vite build\``);
}

// Idempotent: a second run must not wrap the wrapper.
if (readFileSync(ENTRY, 'utf8').includes(MARKER)) {
	console.log('wrap-worker: already wrapped, nothing to do');
	process.exit(0);
}

renameSync(ENTRY, INNER);

writeFileSync(
	ENTRY,
	`${MARKER}
import inner from './_sk-worker.js';

// A Durable Object class must be a NAMED EXPORT of the worker entry, and this
// entry is generated — so the export has to be emitted here. Resolved from
// .svelte-kit/cloudflare/, two levels up is the repo root. wrangler's esbuild
// bundles it, and that build has no $lib alias and no $env virtual module,
// which is why everything room-do.js imports must be relative (check:noenv).
export { RoomDO } from '../../src/lib/do/room-do.js';

const WS_PATH = /^\\/api\\/rooms\\/(\\d+)\\/ws$/;

/**
 * WebSocket upgrades are intercepted BEFORE SvelteKit sees them.
 *
 * Not a preference: SvelteKit runs add_cookies_to_headers on the response
 * outside any try/catch, and a Response from a DO stub has immutable headers.
 * Any request where requireUser refreshes a cookie would throw — an intermittent
 * 500 on the handshake, which would look exactly like a DO bug. The adapter also
 * consults caches.default before server.respond, and an upgrade is a GET.
 */
async function handleUpgrade(req, env, ctx, roomId) {
	// Auth runs through the normal SvelteKit route so requireMemberCached and its
	// coded 403s are reused verbatim. One sub-request per handshake, not per frame.
	const authReq = new Request(\`https://internal/api/rooms/\${roomId}/ws-auth\`, {
		headers: { cookie: req.headers.get('cookie') ?? '' }
	});
	const authRes = await inner.fetch(authReq, env, ctx);
	if (authRes.status !== 200) {
		// Mirror the real status/body: 'removed' and 'not_member' are terminal on
		// the client, and turning them into a generic failure would make a removed
		// player reconnect forever.
		return new Response(await authRes.text(), {
			status: authRes.status,
			headers: { 'content-type': 'application/json' }
		});
	}
	const { uid, name } = await authRes.json();

	const id = env.ROOM.idFromName(\`room:\${Number(roomId)}\`);
	// locationHint is honoured ONLY at first instantiation and can never be
	// changed afterwards — always from env, never from request.cf, or a room
	// created by a travelling host is pinned to the wrong continent forever.
	const stub = env.ROOM.get(id, { locationHint: env.DO_LOCATION_HINT || undefined });
	const fwd = new Request(req);
	fwd.headers.set('x-uid', String(uid));
	fwd.headers.set('x-name', name ?? '');
	// The DO knows its own id only as an opaque hash (idFromName is one-way), so
	// it cannot look itself up in Odoo without being told which room it is.
	fwd.headers.set('x-room-id', String(roomId));
	return stub.fetch(fwd);
}

export default {
	async fetch(req, env, ctx) {
		const m = WS_PATH.exec(new URL(req.url).pathname);
		if (m && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
			return handleUpgrade(req, env, ctx, m[1]);
		}
		return inner.fetch(req, env, ctx);
	},
	async scheduled(event, env, ctx) {
		// Host is arbitrary — this request never leaves the isolate — but the path
		// must match the route. The secret is what stops the same endpoint being
		// reachable from the internet; it deletes rooms.
		const req = new Request('https://cron.invalid/api/cron/sweep', {
			method: 'POST',
			headers: { 'x-cron-secret': env.CRON_SECRET ?? '' }
		});
		ctx.waitUntil(
			inner
				.fetch(req, env, ctx)
				.then(async (res) => {
					const body = await res.text().catch(() => '');
					console.log(JSON.stringify({
						t: 'cron', cron: event.cron, status: res.status, body: body.slice(0, 200)
					}));
				})
				.catch((e) => console.error('cron dispatch failed:', e?.message))
		);
	}
};
`
);

// The adapter lists _worker.js in .assetsignore so it is not also served as a
// static file. The renamed inner worker needs the same treatment, or it ships as
// a publicly fetchable copy of the server bundle.
appendFileSync(`${DIR}/.assetsignore`, '\n_sk-worker.js\n');

console.log('wrap-worker: added scheduled handler to _worker.js');

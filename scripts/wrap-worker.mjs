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

export default {
	fetch: inner.fetch,
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

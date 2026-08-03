// The Durable Object runtime suite.
//
// The check:* scripts run under plain node and cover pure logic; Playwright
// mocks every /api/* call and never touches the runtime. Neither can reach the
// three things that only exist inside workerd: alarm scheduling, WebSocket
// hibernation, and whether the object's own concurrency lets a watermark
// overtake the events it vouches for.
//
// `main` points at worker-test/do-entry.js, NOT the generated SvelteKit worker —
// see the note there.
//
// worker-test/, not test/: `tests/` is Playwright's (playwright.config.js sets
// testDir there) and two directories one letter apart, each owned by a different
// runner, is a trap. These run inside workerd; those run a browser against a
// fully mocked app.
//
// @cloudflare/vitest-pool-workers 0.20 exposes a Vite PLUGIN (`cloudflareTest`).
// The `defineWorkersConfig` helper every older example uses was published under
// a `./config` subpath that no longer exists, and the failure is a build-time
// "Missing ./config specifier" that looks like a broken install rather than an
// API change. Noted because the next person will copy an old example.
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './worker-test/do-entry.js',
			// One worker: these tests share nothing, and a pool would multiply
			// workerd startup across a suite that runs in a couple of seconds.
			miniflare: {
				compatibilityDate: '2026-07-01',
				compatibilityFlags: ['nodejs_compat'],
				durableObjects: {
					// useSQLite mirrors wrangler.toml's `new_sqlite_classes`. Without it
					// ctx.storage.sql does not exist and every test fails on the schema
					// migration rather than on anything it meant to assert.
					ROOM: { className: 'RoomDO', useSQLite: true }
				},
				bindings: {
					// Present so adminFor() can build a client, and deliberately pointed
					// at a host that does not resolve: a test that reaches Odoo without
					// having seeded storage first must FAIL rather than quietly hit the
					// network. Tests seed the object's storage directly instead, which is
					// also what keeps them fast and deterministic.
					ODOO_URL: 'https://odoo.invalid',
					ODOO_DB: 'testdb',
					ODOO_USERNAME: 'test',
					ODOO_API_KEY: 'test',
					DO_ROOMS: 'all',
					DO_LOCATION_HINT: 'me'
				}
			}
		})
	],
	test: {
		include: ['worker-test/**/*.test.js']
	}
});

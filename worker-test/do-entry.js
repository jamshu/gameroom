// Test-only worker entry: the Durable Object and nothing else.
//
// DELIBERATELY NOT .svelte-kit/cloudflare/_worker.js. Pointing the suite at the
// generated entry would make every DO unit test depend on a full SvelteKit
// build — slow, and it couples a test of storage and alarms to whether the app's
// routes happen to compile. The class is the unit under test; the wrapper's job
// (auth, the upgrade intercept) is covered by scripts/do-push-probe.mjs against
// a real deployment, which is the only place it can be covered honestly.
export { RoomDO } from '../src/lib/do/room-do.js';

export default {
	async fetch() {
		return new Response('do test entry');
	}
};

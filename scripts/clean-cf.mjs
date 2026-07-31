// Remove the previous build's Cloudflare output BEFORE vite runs.
//
// Windows-only problem, but it fails the whole build when it hits:
//
//   Error: EBUSY: resource busy or locked, rmdir '.svelte-kit/cloudflare'
//     at adapt (@sveltejs/adapter-cloudflare/index.js:77)
//
// adapter-cloudflare rimrafs that directory at the START of adapt(), i.e. after
// vite has just finished writing hundreds of files into the tree. On Windows a
// virus scanner, a file watcher or an editor indexing the workspace routinely
// still holds a handle at that instant, and the adapter's rimraf has no retry —
// one unlucky handle and the build dies. Nothing is actually wrong; running it
// again usually "fixes" it, which is exactly what makes it maddening.
//
// Doing the delete up front sidesteps it: by the time the adapter rimrafs, the
// directory is already gone and removing a missing path is a no-op. And here we
// CAN retry, because fs.rmSync has maxRetries/retryDelay for precisely this
// class of failure — a backoff the adapter's own call does not pass.
import { rmSync, existsSync } from 'node:fs';

const DIR = '.svelte-kit/cloudflare';

if (existsSync(DIR)) {
	try {
		rmSync(DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
	} catch (e) {
		console.error(`\nCould not remove ${DIR}: ${e.message}\n`);
		console.error('Something is holding a handle on it. Usually one of:');
		console.error('  - a `wrangler dev` / workerd process still running');
		console.error('  - the folder open in a file explorer or a terminal sitting inside it');
		console.error('  - an editor indexing it (exclude .svelte-kit from your watcher)\n');
		console.error('Check with:  Get-Process node,workerd\n');
		process.exit(1);
	}
}

import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Cloudflare Workers. The prerendered page shell and all assets are served
		// from Cloudflare's edge; only /api/* reaches the Worker.
		// No `routes` option here: it only emits _routes.json when building for
		// Cloudflare PAGES (adapter index.js:156), so on Workers it is silently
		// ignored. Keeping the Worker off static paths is done with
		// `assets.run_worker_first` in wrangler.toml instead.
		adapter: adapter(),
		prerender: {
			// /room/[id] is dynamic; with ssr=false the runtime serves the SPA shell.
			// That fallback is configured in wrangler.toml via
			// assets.not_found_handling — miss it and every hard refresh of a room
			// URL 404s, which the Amplify adapter used to handle implicitly.
			handleUnseenRoutes: 'ignore'
		}
	}
};

export default config;

import adapter from 'amplify-adapter';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Amplify adapter: prerendered page shell is served statically, while the
		// /api/* server routes run in Amplify Web Compute (SSR Lambda).
		adapter: adapter(),
		prerender: {
			// /room/[id] is dynamic; with ssr=false the runtime serves the SPA shell
			handleUnseenRoutes: 'ignore'
		}
	}
};

export default config;

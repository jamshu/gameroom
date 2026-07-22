// Service worker source for vite-plugin-pwa injectManifest mode (srcDir: 'src').
// Registered manually in the root +layout.svelte onMount (SvelteKit has no static
// index.html for the plugin's auto-registration). Precache-only — no push here.
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

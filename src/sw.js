// Service worker source for vite-plugin-pwa injectManifest mode (srcDir: 'src').
// Registered manually in the root +layout.svelte onMount (SvelteKit has no static
// index.html for the plugin's auto-registration). Precache + web push.
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Web push. Handles two payload shapes: the app's {title, body, url} and Odoo's
// native {title, options: {body, data}}.
self.addEventListener('push', (event) => {
	let payload = {};
	if (event.data) {
		try {
			payload = event.data.json();
		} catch {
			payload = { body: event.data.text() };
		}
	}
	const title = payload.title || 'Gamerooms';
	const body = payload.body ?? payload.options?.body ?? '';
	const url = payload.url ?? payload.options?.data?.url ?? '/';
	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			// an incoming call sets these: stay on screen until tapped/dismissed
			// (requireInteraction) and buzz a ring-like pattern; a `tag` collapses
			// repeat rings into the same notification
			requireInteraction: !!payload.requireInteraction,
			tag: payload.tag,
			renotify: payload.tag ? true : undefined,
			vibrate: payload.vibrate,
			data: { url }
		})
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = event.notification.data?.url || '/';
	event.waitUntil(
		(async () => {
			const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
			const client = wins.find((w) => w.url.includes(self.location.origin));
			if (client) {
				// Focus the open app AND drive it to the room. navigate() is what was
				// missing/failing before — without a reliable navigate the focused tab
				// just sat on the dashboard. Fall back to a fresh window if it can't.
				try {
					await client.focus();
					if (client.navigate) {
						await client.navigate(target);
						return;
					}
				} catch {
					/* navigate blocked (cross-scope, or unsupported) — open instead */
				}
			}
			await clients.openWindow(target);
		})()
	);
});

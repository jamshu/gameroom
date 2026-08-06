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
	const isCall = String(payload.tag || '').startsWith('call-');
	event.waitUntil(
		(async () => {
			await self.registration.showNotification(title, {
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
			});
			// If the app is open anywhere, tell it to actually RING (a system
			// notification only plays one short chime — an open page can loop a
			// ringtone and show Answer/Decline).
			if (isCall) {
				const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
				for (const w of wins) w.postMessage({ type: 'incoming-call', title, body, url });
			}
		})()
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = event.notification.data?.url || '/';
	event.waitUntil(
		clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
			const match = wins.find((w) => w.url.includes(self.location.origin));
			if (match) {
				match.focus();
				return match.navigate ? match.navigate(target).catch(() => {}) : undefined;
			}
			return clients.openWindow(target);
		})
	);
});

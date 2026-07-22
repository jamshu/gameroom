// Service worker source for vite-plugin-pwa injectManifest mode (srcDir: 'src').
// Register manually in the root +layout.svelte onMount (SvelteKit has no static
// index.html for the plugin's auto-registration):
//   if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
// npm i -D workbox-precaching workbox-core
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('push', (event) => {
	let payload = {};
	if (event.data) {
		try {
			payload = event.data.json();
		} catch {
			payload = { body: event.data.text() };
		}
	}
	// two payload shapes: app pushes {title, body, url}; Odoo native pushes
	// {title, options: {body, icon, data: {model, res_id}}}
	const title = payload.title || 'ShareNote';
	const body = payload.body ?? payload.options?.body ?? '';
	const url =
		payload.url ??
		(payload.options?.data?.res_id ? `/note/${payload.options.data.res_id}` : '/');
	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			data: { url }
		})
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

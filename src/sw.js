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
			// A call gets the platform's LOOPING ringtone + Answer/Decline call
			// buttons + DND break-through, on browsers that support it (installed
			// PWAs on Chromium/Edge). Everywhere else these keys are ignored and it
			// falls back to a normal notification — no regression.
			...(isCall && {
				scenario: 'incoming-call',
				actions: [
					{ action: 'answer', title: '📹 Answer' },
					{ action: 'decline', title: 'Decline' }
				]
			}),
			data: { url }
		})
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	// Decline just dismisses — no navigation, no server call.
	if (event.action === 'decline') return;
	const target = event.notification.data?.url || '/';
	event.waitUntil(
		(async () => {
			// Stash the destination so the app can self-route on launch. iOS home-
			// screen PWAs IGNORE the URL passed to openWindow()/navigate() and always
			// start at the manifest start_url (the dashboard) — reading this on mount
			// is the only reliable way to land them in the room across platforms.
			try {
				const c = await caches.open('gr-nav');
				await c.put('/__pending_nav', new Response(JSON.stringify({ url: target, at: Date.now() })));
			} catch {
				/* cache unavailable — fall back to navigate/openWindow below */
			}
			const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
			const client = wins.find((w) => w.url.includes(self.location.origin));
			if (client) {
				try {
					await client.focus();
					if (client.navigate) {
						await client.navigate(target);
						return;
					}
				} catch {
					/* navigate blocked — open a fresh window instead */
				}
			}
			await clients.openWindow(target);
		})()
	);
});

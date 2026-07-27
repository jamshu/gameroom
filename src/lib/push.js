// Browser push: register the service worker, subscribe with the VAPID public
// key, persist the subscription via /api/push/subscribe.
import { browser } from '$app/environment';
import { base } from '$app/paths';
import { env } from '$env/dynamic/public';

const VAPID_PUBLIC_KEY = env.PUBLIC_VAPID_PUBLIC_KEY || '';

export function pushSupported() {
	return browser && 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function registerSW() {
	if (!browser || !('serviceWorker' in navigator)) return null;
	const existing = await navigator.serviceWorker.getRegistration();
	if (existing) return existing;
	return navigator.serviceWorker.register('/sw.js', { type: 'classic' });
}

async function swReady() {
	const reg = await registerSW();
	if (reg?.active) return reg;
	return Promise.race([
		navigator.serviceWorker.ready,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error('Service worker not active after 30s')), 30000)
		)
	]);
}

export async function currentSubscription() {
	if (!pushSupported()) return null;
	const reg = await swReady();
	return reg.pushManager.getSubscription();
}

export async function subscribePush() {
	if (!pushSupported()) throw new Error('Push not supported in this browser');
	if (!VAPID_PUBLIC_KEY) throw new Error('VAPID public key not configured');
	// Chrome only shows the prompt from a user gesture — call this off a click.
	// An origin the user blocked (or dismissed a few times — Chrome then
	// auto-embargoes it) resolves 'denied' with NO prompt; only the user can
	// unblock it from the browser's site settings.
	if (Notification.permission === 'denied') {
		throw new Error(
			'Notifications are blocked for this site. Click the lock icon in the ' +
				'address bar → Site settings → allow Notifications, then try again.'
		);
	}
	const perm = await Notification.requestPermission();
	if (perm !== 'granted') throw new Error(`Notification permission: ${perm}`);
	const reg = await swReady();
	const sub = await reg.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
	});
	const raw = sub.toJSON();
	const res = await fetch(`${base}/api/push/subscribe`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ endpoint: raw.endpoint, keys: raw.keys })
	});
	if (!res.ok) throw new Error('Failed to save subscription');
	return sub;
}

export async function unsubscribePush() {
	if (!pushSupported()) return;
	const reg = await swReady();
	const sub = await reg.pushManager.getSubscription();
	if (sub) {
		const endpoint = sub.endpoint;
		await sub.unsubscribe();
		await fetch(`${base}/api/push/subscribe`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ endpoint })
		});
	}
}

function urlBase64ToUint8Array(base64String) {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(base64);
	return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

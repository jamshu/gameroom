// Local identity: a client-generated uuid + display name kept in localStorage.
// No login. The name/avatar are mirrored to the server (x_player) so other
// players can see them; the avatar itself is served from there by uid.
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const KEY = 'gr_profile';
// undefined = still reading storage · null = none yet (show modal) · object = ready
export const profile = writable(undefined);

function load() {
	try {
		return JSON.parse(localStorage.getItem(KEY) || 'null');
	} catch {
		return null;
	}
}

/** Read the stored profile on boot; null triggers the first-visit modal. */
export function initProfile() {
	if (!browser) return;
	const p = load();
	profile.set(p?.uid && p?.name ? p : null);
}

/**
 * Create/update the profile. `avatar` is a ≤512px base64 (no data-url prefix) or
 * null to leave the current one. Generates the uuid once, persists locally, sets
 * the gr_uid cookie, and upserts x_player server-side.
 */
export async function saveProfile({ name, avatar }) {
	const existing = load() || {};
	const uid = existing.uid || crypto.randomUUID();
	const trimmed = String(name || '').trim();
	if (!trimmed) throw new Error('Name is required');

	const res = await fetch('/api/profile', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ uid, name: trimmed, avatar: avatar || undefined })
	});
	const d = await res.json().catch(() => ({}));
	if (!res.ok || !d.ok) throw new Error(d.error || 'Save failed');

	const next = { uid, name: trimmed };
	localStorage.setItem(KEY, JSON.stringify(next));
	document.cookie = `gr_uid=${uid}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
	profile.set(next);
	return next;
}

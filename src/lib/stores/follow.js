// Who the current user follows. One shared set for the session, loaded once.
// ponytail: reload on login; a follow change made in another tab won't show
// until reload — fine for this feature.
import { writable } from 'svelte/store';
import { api } from '$lib/api.js';

const set = new Set();
const { subscribe, set: put } = writable(set);
const emit = () => put(new Set(set)); // new ref so Svelte reacts

let loaded = false;
async function load() {
	if (loaded) return;
	loaded = true;
	try {
		// non-critical: a 401 here must not bounce the user to /login
		const { following } = await api('/api/follow', { redirectOn401: false });
		for (const id of following) set.add(Number(id));
		emit();
	} catch {
		loaded = false; // let a later mount retry
	}
}

/** Optimistic toggle; revert if the write fails. */
async function toggle(uid) {
	uid = Number(uid);
	const wasFollowing = set.has(uid);
	const action = wasFollowing ? 'unfollow' : 'follow';
	if (wasFollowing) set.delete(uid);
	else set.add(uid);
	emit();
	try {
		await api('/api/follow', { method: 'POST', body: { targetUid: uid, action } });
	} catch {
		if (wasFollowing) set.add(uid);
		else set.delete(uid);
		emit();
	}
}

export const following = { subscribe };
export const follow = { load, toggle };

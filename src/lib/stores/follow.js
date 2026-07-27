// Who the current user follows. One shared set for the session, loaded once, so
// the in-room buttons and the People page stay in sync off a single source.
// ponytail: reload on login; a follow change in another tab won't show until reload.
import { writable } from 'svelte/store';
import { api } from '$lib/api.js';

const set = new Set(); // uids I follow
const names = new Map(); // uid -> name (for the People page's Following list)

const followingStore = writable(set);
const peopleStore = writable([]);
function emit() {
	followingStore.set(new Set(set)); // new refs so Svelte reacts
	peopleStore.set(
		[...set].map((uid) => ({ uid, name: names.get(uid) ?? '' }))
			.sort((a, b) => a.name.localeCompare(b.name))
	);
}

let loaded = false;
async function load() {
	if (loaded) return;
	loaded = true;
	try {
		// non-critical: a 401 here must not bounce the user to /login
		const { following, people = [] } = await api('/api/follow', { redirectOn401: false });
		for (const id of following) set.add(Number(id));
		for (const p of people) names.set(Number(p.uid), p.name);
		emit();
	} catch {
		loaded = false; // let a later mount retry
	}
}

/** Optimistic toggle; revert if the write fails. `name` keeps the list labelled. */
async function toggle(uid, name) {
	uid = Number(uid);
	const wasFollowing = set.has(uid);
	const action = wasFollowing ? 'unfollow' : 'follow';
	if (wasFollowing) set.delete(uid);
	else {
		set.add(uid);
		if (name) names.set(uid, name);
	}
	emit();
	try {
		await api('/api/follow', { method: 'POST', body: { targetUid: uid, action } });
	} catch {
		if (wasFollowing) set.add(uid);
		else set.delete(uid);
		emit();
	}
}

export const following = { subscribe: followingStore.subscribe };
export const followingPeople = { subscribe: peopleStore.subscribe };
export const follow = { load, toggle };

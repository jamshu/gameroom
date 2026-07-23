// Ably push: carry the actual change to browsers so they never poll Odoo for it.
// - game state is per-uid FILTERED (thief roles/envelopes stay secret) and sent
//   on each member's private channel `room:{id}:u:{uid}`,
// - public events (chat, system) go on the shared `room:{id}` channel,
// - targeted events (WebRTC signals) go on the recipient's private channel.
// Everything no-ops when ABLY_API_KEY is unset, so the app still runs on polling.
import { env } from '$env/dynamic/private';
import { stateView } from './gamelogic.js';

/** Public room channel — carries public events. Pure. */
export function roomChannel(roomId) {
	return `room:${Number(roomId)}`;
}

/** A member's private channel — carries their filtered state + targeted events. Pure. */
export function userChannel(roomId, uid) {
	return `room:${Number(roomId)}:u:${uid}`;
}

/** Ably capability: subscribe to the room's public channel + this user's own. Pure. */
export function tokenCapability(roomId, uid) {
	return { [roomChannel(roomId)]: ['subscribe'], [userChannel(roomId, uid)]: ['subscribe'] };
}

let _rest = null;
async function ablyRest() {
	if (!env.ABLY_API_KEY) return null;
	if (!_rest) {
		const Ably = await import('ably');
		_rest = new Ably.Rest(env.ABLY_API_KEY);
	}
	return _rest;
}

/**
 * Push the new state to each member's private channel, filtered per-uid so a
 * thief-finder secret never leaves the server. Best-effort — a publish failure
 * must never fail the mutation (the client's safety poll still catches it).
 */
export async function publishState(roomId, state, memberUids = []) {
	try {
		const rest = await ablyRest();
		if (!rest || !memberUids.length) return;
		await Promise.all(
			memberUids.map((uid) =>
				rest.channels.get(userChannel(roomId, uid)).publish('state', stateView(state, uid))
			)
		);
	} catch (e) {
		console.error('publishState failed:', e?.message);
	}
}

/** Push one event: public → room channel, targeted → the recipient's channel. */
export async function publishEvent(roomId, event, targetUid = null) {
	try {
		const rest = await ablyRest();
		if (!rest) return;
		const name = targetUid ? userChannel(roomId, targetUid) : roomChannel(roomId);
		await rest.channels.get(name).publish('event', event);
	} catch (e) {
		console.error('publishEvent failed:', e?.message);
	}
}

/** A signed token request scoped to this room + user, for the browser's authUrl. */
export async function roomTokenRequest(roomId, uid) {
	const rest = await ablyRest();
	if (!rest) return null;
	return rest.auth.createTokenRequest({ capability: tokenCapability(roomId, uid), clientId: String(uid) });
}

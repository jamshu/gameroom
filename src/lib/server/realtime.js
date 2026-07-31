// Ably push: carry the actual change to browsers so they never poll Odoo for it.
// - game state is per-uid FILTERED (thief roles/envelopes stay secret) and sent
//   on each member's private channel `room:{id}:u:{uid}`,
// - public events (chat, system) go on the shared `room:{id}` channel,
// - targeted events (WebRTC signals) go on the recipient's private channel.
// Everything no-ops when ABLY_API_KEY is unset, so the app still runs on polling.
import { env } from '$env/dynamic/private';
import { getRequestEvent } from '$app/server';
import { stateView } from './gamelogic.js';
import { isDoRoom } from './doflag.js';

/* ---- Durable Object dispatch ----------------------------------------------
   The seam. writeState/appendEvent/pushRoster already funnel every push through
   the four publish* functions below, so branching here moves the transport for
   the whole app without touching a single caller.

   The binding lives on the RequestEvent, and threading `platform` through ~25
   call sites would be a far bigger diff than the feature. getRequestEvent()
   reads it from AsyncLocalStorage instead — which is exactly why wrangler.toml
   needs nodejs_compat (SvelteKit's internal/event.js imports node:async_hooks).

   Best-effort, like the Ably path it replaces: a push failure must never fail
   the mutation. The state is already persisted by the time we get here. */

function roomStub(roomId) {
	// getRequestEvent throws outside a request (and, on a cold isolate, before
	// SvelteKit's async_hooks import has resolved). Neither is worth failing a
	// write over.
	let platform;
	try {
		({ platform } = getRequestEvent());
	} catch {
		return null;
	}
	const ns = platform?.env?.ROOM;
	if (!ns) return null;
	return ns.get(ns.idFromName(`room:${Number(roomId)}`), {
		locationHint: platform.env.DO_LOCATION_HINT || undefined
	});
}

async function doApply(roomId, op) {
	try {
		const stub = roomStub(roomId);
		if (!stub) {
			console.error(`doApply: no ROOM binding for room ${roomId} — push dropped`);
			return;
		}
		const res = await stub.fetch('https://do/apply', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(op)
		});
		if (!res.ok) console.error(`doApply ${op.op} -> ${res.status}`);
	} catch (e) {
		console.error(`doApply ${op?.op} failed:`, e?.message);
	}
}

/** Public room channel — carries public events. Pure. */
export function roomChannel(roomId) {
	return `room:${Number(roomId)}`;
}

/** A member's private channel — carries their filtered state + targeted events. Pure. */
export function userChannel(roomId, uid) {
	return `room:${Number(roomId)}:u:${Number(uid)}`;
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
	// The DO filters per socket with the same stateView, so it takes the state
	// whole — no memberUids fan-out, and no dependency on roomUids being warm.
	if (isDoRoom(roomId)) return doApply(roomId, { op: 'state', state });
	try {
		const rest = await ablyRest();
		if (!rest) return; // realtime not configured — polling carries the room
		// Deliberately NOT merged with the guard above: "Ably is off" is a config
		// choice, but "a state write had no members to push to" is a bug, and it
		// degrades silently — everyone else waits out the 60s safety poll. Callers
		// re-read before reaching here (see writeState), so this should be dead code.
		if (!memberUids.length) {
			console.error(`publishState: no member uids for room ${roomId} — state push dropped`);
			return;
		}
		await Promise.all(
			memberUids.map((uid) =>
				rest.channels.get(userChannel(roomId, uid)).publish('state', stateView(state, uid))
			)
		);
	} catch (e) {
		console.error('publishState failed:', e?.message);
	}
}

/**
 * Push the room row + member roster on the PUBLIC channel.
 *
 * Safe to share: the poll already hands both to every member, and the `role` in
 * here is SEATING (player/spectator, written by reseatRoles) — the thief-finder
 * roles are a different thing entirely, living in the state blob and filtered by
 * stateView. Nothing per-uid, so one publish serves the whole room.
 *
 * `ts` is the ordering guard. Unlike state, room/members carry no version of
 * their own, so a client that receives two rosters out of order has no other way
 * to tell which is newer.
 *
 * Best-effort like the rest: a publish failure must never fail the mutation.
 */
export async function publishRoster(roomId, { room, members }) {
	if (isDoRoom(roomId)) return doApply(roomId, { op: 'roster', room, members });
	try {
		const rest = await ablyRest();
		if (!rest) return;
		await rest.channels.get(roomChannel(roomId)).publish('roster', { ts: Date.now(), room, members });
	} catch (e) {
		console.error('publishRoster failed:', e?.message);
	}
}

/** Push one event: public → room channel, targeted → the recipient's channel. */
export async function publishEvent(roomId, event, targetUid = null) {
	if (isDoRoom(roomId)) return doApply(roomId, { op: 'event', event, targetUid });
	try {
		const rest = await ablyRest();
		if (!rest) return;
		const name = targetUid ? userChannel(roomId, targetUid) : roomChannel(roomId);
		await rest.channels.get(name).publish('event', event);
	} catch (e) {
		console.error('publishEvent failed:', e?.message);
	}
}

/**
 * Push a live striker/aim cursor on the PUBLIC channel. Ephemeral — no Odoo
 * write, no event id, no state version. Best-effort like the rest.
 */
export async function publishAim(roomId, data) {
	if (isDoRoom(roomId)) return doApply(roomId, { op: 'aim', data });
	try {
		const rest = await ablyRest();
		if (!rest) return;
		await rest.channels.get(roomChannel(roomId)).publish('aim', data);
	} catch (e) {
		console.error('publishAim failed:', e?.message);
	}
}

/** A signed token request scoped to this room + user, for the browser's authUrl. */
export async function roomTokenRequest(roomId, uid) {
	const rest = await ablyRest();
	if (!rest) return null;
	return rest.auth.createTokenRequest({ capability: tokenCapability(roomId, uid), clientId: String(uid) });
}

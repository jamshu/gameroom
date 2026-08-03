// Push: carry the actual change to browsers so they never poll for it.
//
// FOUR NAMES, ONE TRANSPORT. writeState, appendEvent and pushRoster funnel every
// push in the app through the functions below, which is what let the transport be
// swapped underneath ~25 call sites without touching one of them. Ably was that
// transport until M2.5; the room's Durable Object is now, and these survive as
// the dispatchers rather than being inlined at the call sites — the indirection
// is the thing that made the migration possible and is worth keeping for the
// next one.
//
// - game state is per-uid FILTERED (thief roles/envelopes stay secret) and the
//   object applies the same stateView per socket,
// - public events (chat, system) go to every socket in the room,
// - targeted events (WebRTC signals) go only to their recipient's sockets.
//
// Best-effort, all four: a push failure must never fail the mutation. The state
// is already persisted by the time any of these run — which is why they discard
// doOp's result, `evacuated` included. A push into an evacuated object is simply
// a push nobody needed; the writer that produced the state has already dealt with
// the fallback (see writeState in room.js).
import { isDoRoom } from './doflag.js';
import { doOp } from './dostub.js';

/**
 * Push the new state. The object filters per socket with the same stateView, so
 * it takes the state whole — no per-uid fan-out here, and no dependency on the
 * caller knowing who is in the room.
 */
export async function publishState(roomId, state) {
	if (!isDoRoom(roomId)) return;
	return doOp(roomId, { op: 'state', state });
}

/**
 * Push the room row + member roster.
 *
 * Safe to share with everyone: the poll already hands both to every member, and
 * the `role` here is SEATING (player/spectator) — thief-finder roles are a
 * different thing entirely, living in the state blob behind stateView.
 *
 * Call after ANY write that changes those two rows. State pushes carry neither,
 * so without this a role change, a join approval or a host handover would reach
 * the rest of the room no sooner than their next poll — and, since M2.4, the
 * object's own copy of the room row would go stale with it.
 */
export async function publishRoster(roomId, { room, members }) {
	if (!isDoRoom(roomId)) return;
	return doOp(roomId, { op: 'roster', room, members });
}

/** Push one event: public to the whole room, targeted to one recipient. */
export async function publishEvent(roomId, event, targetUid = null) {
	if (!isDoRoom(roomId)) return;
	return doOp(roomId, { op: 'event', event, targetUid });
}

/**
 * Push a live striker/aim cursor. Ephemeral — no storage, no event id, no state
 * version. It fires ~10x/second while a player lines up a shot and nothing
 * durable rides on it.
 */
export async function publishAim(roomId, data) {
	if (!isDoRoom(roomId)) return;
	return doOp(roomId, { op: 'aim', data });
}

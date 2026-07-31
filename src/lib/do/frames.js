// The wire protocol, in one place so the DO and check:protocol cannot drift.
//
// ISOMORPHIC BY CONTRACT — no `$lib`, no `$env`.
//
// THE `upto` INVARIANT, which every builder here exists to protect:
//
//   The DO must never send a frame with upto = N on a socket unless every event
//   with seq <= N that this socket is entitled to has already been sent on that
//   same socket, in order.
//
// Why it is not automatic: targeted events (WebRTC signals) are filtered per
// socket, so each client's view of the sequence has holes BY DESIGN and cannot
// tell "filtered out" from "not yet sent". The watermark is the only thing that
// lets the cursor advance safely, which is what makes the poll a fallback rather
// than the source of truth.
//
// Two paths, two different hazards:
//   - append: stamp upto at insert time and send synchronously, with NO await
//     between the insert and the last ws.send(). An await yields the isolate and
//     lets another append interleave.
//   - welcome/resync: necessarily awaits (query, then send). upto here is the max
//     seq PRESENT IN THE REPLAY, never the current head — otherwise a joiner's
//     cursor leaps past an event that went only to already-connected sockets.

export const PROTOCOL_VERSION = 1;

/** Highest seq actually present in a replay array, or `floor` when empty. */
export function uptoOf(events, floor = 0) {
	let max = Number(floor) || 0;
	for (const e of events) if (e.id > max) max = e.id;
	return max;
}

/**
 * Full state handout for a joining socket.
 * `gap` tells the client its cursor fell below the retained log and it must
 * resync rather than assume continuity — the HTTP fallback carries the same flag.
 */
export function welcome({ room, members, state, events, epoch, gap = false }) {
	const f = {
		t: gap ? 'resync' : 'welcome',
		v: PROTOCOL_VERSION,
		room,
		members,
		state,
		events,
		upto: uptoOf(events),
		epoch
	};
	if (gap) f.gap = true;
	return f;
}

/** A per-uid filtered state push. `upto` is stamped by the caller at append time. */
export function stateFrame(state, upto) {
	return { t: 'state', state, upto };
}

/** One event, already filtered for this socket's uid. */
export function eventFrame(event, upto) {
	return { t: 'event', event, upto };
}

/** Room row + member list. Carries `ts` for the same reason the Ably roster did:
 *  room/members have no version of their own, so two frames can arrive out of
 *  order and there is nothing else to compare. */
export function rosterFrame(room, members, ts = Date.now()) {
	return { t: 'roster', room, members, ts };
}

/** Ephemeral carrom aim cursor. No seq, no storage, no ack — deliberately.
 *  It fires ~8/s while a player lines up a shot and nothing durable rides on it. */
export function aimFrame(data) {
	return { t: 'aim', data };
}

/** Reply to a client op. `id` echoes the request so postSocket can settle it. */
export function ackFrame(id, ok, extra = {}) {
	return { t: 'ack', id, ok, ...extra };
}

/** Error reply. `status`/`code` mirror what api() throws so the client's existing
 *  error handling — including the terminal `removed`/`not_member` codes — works
 *  unchanged over the socket. */
export function errFrame(id, status, error, code) {
	const f = { t: 'ack', id, ok: false, status, error };
	if (code) f.code = code;
	return f;
}

/* Close codes. 4001/4003 map onto the client's existing terminal paths so a
   revoked member lands on "the host removed you" rather than a reconnect loop. */
export const CLOSE = {
	REAUTH: 4001, // token/session no longer valid — reconnect after re-auth
	EVACUATED: 4002, // DO handed the room back; fall back to HTTP
	KICKED: 4003 // membership revoked — terminal, stop reconnecting
};

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

/**
 * Has this client's cursor fallen below what the log still retains?
 *
 * If so, continuity CANNOT be proven: the trim alarm dropped rows between their
 * cursor and the oldest we hold, and answering with the window they asked for
 * would advance their cursor past a block they never received — permanently,
 * because `?since=` only ever moves forward. Saying "gap" instead lets the client
 * rebuild.
 *
 * One function, deliberately, because BOTH transports have to answer this the
 * same way: the socket turns it into a `resync` frame, the HTTP fallback into a
 * `gap: true` field. Two copies of the comparison is how they start disagreeing
 * about what a client holds.
 *
 * `since = 0` is a fresh client with nothing to lose, never a gap. `oldest = 0`
 * is an empty log, so there is nothing it could have missed.
 */
export function hasGap(since, oldest) {
	const s = Number(since) || 0;
	const o = Number(oldest) || 0;
	return s > 0 && o > 0 && s < o;
}

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

/**
 * A per-uid filtered state push.
 *
 * DELIBERATELY CARRIES NO `upto`, and this is load-bearing.
 *
 * A state frame delivers no events, so it cannot vouch for any of them. It is
 * also sent to EVERY socket, whereas targeted events go to one — so stamping the
 * current head here tells every client "you have everything up to N" when N may
 * be a WebRTC signal that went to a single recipient.
 *
 * That is how voice broke: a signal for B at seq N, a game move immediately
 * after broadcasting upto=N to everyone, and any socket that missed the signal
 * frame still advanced its cursor past it. The poll's `?since=N` then never
 * refetched it, so the offer/answer/ICE was lost for good — the peer sat in
 * `connecting` until the watchdog tore it down, and the player had to rejoin.
 *
 * Only frames that actually deliver events may move the watermark: eventFrame
 * (to its recipient) and welcome/resync (from what the replay contained).
 */
export function stateFrame(state) {
	return { t: 'state', state };
}

/** One event, already filtered for this socket's uid. */
export function eventFrame(event, upto) {
	return { t: 'event', event, upto };
}

/**
 * Stamp the id the log actually assigned onto an outgoing event.
 *
 * THE SEQ ALWAYS WINS over whatever the caller passed. A pure function purely so
 * this can be asserted, because the shape it replaces was wrong in a way that
 * was invisible for a whole milestone: `{ id: seq, ...event }` spreads the
 * caller's `id` OVER the minted one, and while every event carried an Odoo id
 * those two were the same number. The moment the object began minting its own —
 * `append` passes `id: null` — the spread put null back, and every chat message
 * on the socket arrived keyed on null. That is a duplicate key in the client's
 * keyed {#each}: the exact crash the sequence seed exists to prevent, reached
 * from the other direction.
 */
export function withSeq(event, seq) {
	return { ...event, id: seq };
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

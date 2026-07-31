// One Durable Object per room: authoritative game state plus every player's
// WebSocket, co-located. Replaces "browser -> Worker -> Odoo -> Ably -> browser"
// with a single hop that never touches Odoo on a move.
//
// ISOMORPHIC BY CONTRACT — no `$lib`, no `$env`. wrangler bundles this outside
// the SvelteKit build where neither resolves; `check:noenv` enforces it.
import { stateView } from '../shared/gamelogic.js';
import {
	migrate, kvGet, kvSet, seedSequence,
	appendEvent, eventsFor, newestFor, headSeq, oldestSeq, trim,
	REPLAY_MAX
} from './schema.js';
import { welcome, stateFrame, eventFrame, rosterFrame, aimFrame, ackFrame, errFrame, uptoOf, CLOSE } from './frames.js';

/* Alarm cadences. One alarm, multiplexed: each job stores its own due time in
   kv and alarm() runs whichever are due, then re-arms for the earliest.

   The idle job is the cost story. When the last socket closes it does a final
   flush and then schedules NOTHING — no timer, no sockets, so the object
   hibernates and stops billing duration. Do not add a "just in case" periodic
   alarm; it would quietly make every idle room cost money forever. */
const ARCHIVE_MS = 15_000; // while state/events are dirty
const HEARTBEAT_MS = 60_000; // while >=1 socket — keeps Odoo last_seen fresh
const TRIM_MS = 600_000;
const IDLE_MS = 300_000; // after the last socket closes

export class RoomDO {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		this.sql = ctx.storage.sql;
		// blockConcurrencyWhile: no request may observe a half-migrated schema.
		ctx.blockConcurrencyWhile(async () => migrate(this.sql));
		// Answers the client's 25s keepalive without waking the object — which is
		// what keeps a room with idle players hibernated instead of billing.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('p', 'o'));
	}

	/**
	 * TRUST BOUNDARY. `x-uid` / `x-name` are taken at face value, and that is only
	 * safe because this object is reachable exclusively through the ROOM binding —
	 * never via a public route. The caller (the generated worker wrapper) has
	 * already run requireMemberCached against the session cookie. If you ever add
	 * another way to reach this fetch(), this stops being true.
	 */
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname.endsWith('/health')) {
			return Response.json({
				ok: true,
				sockets: this.ctx.getWebSockets().length,
				head: headSeq(this.sql),
				oldest: oldestSeq(this.sql),
				hydratedAt: kvGet(this.sql, 'hydrated_at'),
				dirtySince: kvGet(this.sql, 'state_dirty_at'),
				evacuated: !!kvGet(this.sql, 'evacuated')
			});
		}

		// Server-side ops, applied by the Worker through the ROOM binding. Same
		// trust boundary as the headers above: unreachable except via the binding.
		if (req.method === 'POST' && url.pathname.endsWith('/apply')) {
			let op;
			try {
				op = await req.json();
			} catch {
				return new Response('bad op', { status: 400 });
			}
			return Response.json(this.apply(op));
		}

		if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected websocket', { status: 426 });
		}
		if (kvGet(this.sql, 'evacuated')) {
			// The room was handed back to the HTTP path; accepting sockets here
			// would resurrect a second writer.
			return new Response('evacuated', { status: 409 });
		}

		const uid = Number(req.headers.get('x-uid'));
		const name = req.headers.get('x-name') || '';
		if (!Number.isInteger(uid) || uid <= 0) return new Response('bad uid', { status: 400 });

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		// Tags, not an in-memory Map: hibernation evicts memory but tags survive,
		// and `u:<uid>` also handles the same player having two tabs open.
		this.ctx.acceptWebSocket(server, [`u:${uid}`, 'room']);
		server.serializeAttachment({ uid, name, openedAt: Date.now() });

		this.armAlarms();
		return new Response(null, { status: 101, webSocket: client });
	}

	/* ---- sockets ---------------------------------------------------------- */

	async webSocketMessage(ws, raw) {
		let msg;
		try {
			msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
		} catch {
			return; // junk frame — ignore rather than close; a bad frame is not a bad session
		}
		const { uid } = ws.deserializeAttachment() ?? {};
		if (!uid) return;

		if (msg.t === 'hello') return this.sendWelcome(ws, uid, Number(msg.cursor) || 0);

		// Ephemeral, deliberately before the op path: no ack, no seq, no storage.
		if (msg.t === 'aim') {
			this.broadcast(aimFrame({ ...msg.data, uid }), (u) => u !== uid);
			return;
		}

		if (msg.t === 'op') {
			// M2.2 is dark: ops are not accepted until M2.4 moves state ownership.
			// Answering with a coded error rather than silence means a client that
			// somehow gets here fails loudly instead of hanging on a pending ack.
			ws.send(JSON.stringify(errFrame(msg.id, 501, 'DO ops not enabled yet', 'do_not_ready')));
		}
	}

	async webSocketClose(ws) {
		// Presence is derived from live sockets, so a close changes the roster.
		this.broadcastRoster();
		this.armAlarms();
	}

	async webSocketError(ws) {
		this.broadcastRoster();
		this.armAlarms();
	}

	/* ---- frames ----------------------------------------------------------- */

	sendWelcome(ws, uid, cursor) {
		const oldest = oldestSeq(this.sql);
		// A cursor below the retained log means we cannot prove continuity, so say
		// so instead of handing back a window that silently skips events.
		const gap = cursor > 0 && oldest > 0 && cursor < oldest;
		const events = gap || cursor === 0 ? newestFor(this.sql, uid) : eventsFor(this.sql, uid, cursor);
		const state = kvGet(this.sql, 'state');
		ws.send(
			JSON.stringify(
				welcome({
					room: kvGet(this.sql, 'room'),
					members: this.membersWithPresence(),
					state: state ? stateView(state, uid) : null,
					events,
					epoch: kvGet(this.sql, 'epoch', 0),
					gap
				})
			)
		);
	}

	/** uids with at least one open socket. Exact, not a 90s staleness guess. */
	liveUids() {
		const s = new Set();
		for (const ws of this.ctx.getWebSockets()) {
			const a = ws.deserializeAttachment();
			if (a?.uid) s.add(a.uid);
		}
		return s;
	}

	membersWithPresence() {
		const members = kvGet(this.sql, 'members', []) ?? [];
		const live = this.liveUids();
		return members.map((m) => ({ ...m, online: live.has(m.uid) }));
	}

	/** Send one already-built frame to every socket (optionally filtered by uid). */
	broadcast(frame, uidFilter) {
		const json = JSON.stringify(frame);
		for (const ws of this.ctx.getWebSockets()) {
			const a = ws.deserializeAttachment();
			if (uidFilter && !uidFilter(a?.uid)) continue;
			try {
				ws.send(json);
			} catch {
				/* a dead socket must not abort the fan-out to the others */
			}
		}
	}

	/**
	 * Per-uid filtered state to every socket.
	 *
	 * NO `await` between the caller's SQL insert and the last send() here — that
	 * is the append half of the upto invariant (see frames.js). One stateView per
	 * uid rather than per socket, so two tabs cost one filter.
	 */
	broadcastState(state, upto) {
		const cache = new Map();
		for (const ws of this.ctx.getWebSockets()) {
			const { uid } = ws.deserializeAttachment() ?? {};
			if (!uid) continue;
			if (!cache.has(uid)) cache.set(uid, JSON.stringify(stateFrame(stateView(state, uid), upto)));
			try {
				ws.send(cache.get(uid));
			} catch {
				/* ignore */
			}
		}
	}

	broadcastRoster() {
		this.broadcast(rosterFrame(kvGet(this.sql, 'room'), this.membersWithPresence()));
	}

	/* ---- ops (applied by the Worker through the ROOM binding) -------------- */

	/**
	 * Dispatch one server-side op. Synchronous on purpose: every branch is SQL
	 * plus a fan-out, and keeping it await-free is half of the upto invariant —
	 * an await between the insert and the last send() would let another append
	 * interleave and hand a socket a watermark covering an event it never got.
	 */
	apply(op) {
		if (kvGet(this.sql, 'evacuated')) return { ok: false, error: 'evacuated' };
		switch (op?.op) {
			case 'state':
				this.applyState(op.state);
				return { ok: true, upto: headSeq(this.sql) };
			case 'event':
				return { ok: true, seq: this.applyEvent(op.event, op.targetUid ?? null) };
			case 'roster':
				this.applyRoster(op.room, op.members);
				return { ok: true };
			case 'aim':
				// Ephemeral: no seq, no storage, no ack. Echoes to everyone but the
				// shooter, who is already rendering their own drag locally.
				this.broadcast(aimFrame(op.data), (u) => u !== Number(op.data?.uid));
				return { ok: true };
			case 'kick':
				this.kick(op.uid);
				return { ok: true };
			case 'destroy':
				this.destroy();
				return { ok: true };
			default:
				return { ok: false, error: `unknown op ${op?.op}` };
		}
	}

	/** Wipe everything and stop. Used when the room is deleted upstream. */
	destroy() {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(CLOSE.KICKED, 'room deleted');
			} catch {
				/* ignore */
			}
		}
		this.ctx.storage.deleteAll();
	}

	/** Append an event and push it, honouring the target filter. */
	applyEvent(event, targetUid = null) {
		const seq = appendEvent(this.sql, {
			// Odoo already assigned this id (appendEvent in server/room.js creates the
			// row first), so carry it rather than minting a competing one — see the
			// note in schema.js appendEvent about the two id spaces.
			seq: event.id ?? null,
			type: event.type,
			sender: event.senderUid,
			target: targetUid,
			payload: event.payload
		});
		const frame = eventFrame({ id: seq, ...event }, seq);
		// Synchronous fan-out, immediately after the insert — see broadcastState.
		this.broadcast(frame, targetUid ? (u) => u === Number(targetUid) : undefined);
		this.markDirty();
		return seq;
	}

	applyState(state) {
		kvSet(this.sql, 'state', state);
		this.broadcastState(state, headSeq(this.sql));
		this.markDirty();
	}

	applyRoster(room, members) {
		if (room) kvSet(this.sql, 'room', room);
		if (members) kvSet(this.sql, 'members', members);
		this.broadcastRoster();
	}

	/** Close a revoked member's sockets. Terminal on the client. */
	kick(uid) {
		for (const ws of this.ctx.getWebSockets(`u:${Number(uid)}`)) {
			try {
				ws.close(CLOSE.KICKED, 'removed');
			} catch {
				/* ignore */
			}
		}
	}

	markDirty() {
		if (!kvGet(this.sql, 'state_dirty_at')) kvSet(this.sql, 'state_dirty_at', Date.now());
		this.armAlarms();
	}

	/* ---- alarms ----------------------------------------------------------- */

	armAlarms() {
		const now = Date.now();
		const sockets = this.ctx.getWebSockets().length;
		const dirty = !!kvGet(this.sql, 'state_dirty_at');

		const due = [];
		if (dirty) due.push(this.ensureDue('next_archive_at', now + ARCHIVE_MS));
		if (sockets > 0) {
			due.push(this.ensureDue('next_heartbeat_at', now + HEARTBEAT_MS));
			due.push(this.ensureDue('next_trim_at', now + TRIM_MS));
			kvSet(this.sql, 'next_idle_at', 0); // someone is here; cancel the wind-down
		} else {
			due.push(this.ensureDue('next_idle_at', now + IDLE_MS));
		}

		const next = due.filter(Boolean).sort((a, b) => a - b)[0];
		if (next) this.ctx.storage.setAlarm(next);
	}

	ensureDue(key, when) {
		const cur = kvGet(this.sql, key, 0);
		if (cur && cur > Date.now()) return cur; // already pending — don't push it out
		kvSet(this.sql, key, when);
		return when;
	}

	async alarm() {
		const now = Date.now();
		const sockets = this.ctx.getWebSockets().length;

		if (this.isDue('next_trim_at', now)) {
			trim(this.sql);
			kvSet(this.sql, 'next_trim_at', 0);
		}

		// M2.2 is dark: archive and heartbeat land in M2.4 with the Odoo client.
		if (this.isDue('next_archive_at', now)) kvSet(this.sql, 'next_archive_at', 0);
		if (this.isDue('next_heartbeat_at', now)) kvSet(this.sql, 'next_heartbeat_at', 0);

		if (sockets === 0 && this.isDue('next_idle_at', now)) {
			kvSet(this.sql, 'next_idle_at', 0);
			// Deliberately schedule NOTHING here. No timer + no sockets = hibernated
			// = zero duration billing. This early return is the cost story.
			return;
		}

		this.armAlarms();
	}

	isDue(key, now) {
		const at = kvGet(this.sql, key, 0);
		return at > 0 && at <= now;
	}
}

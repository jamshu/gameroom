// One Durable Object per room: authoritative game state plus every player's
// WebSocket, co-located. Replaces "browser -> Worker -> Odoo -> Ably -> browser"
// with a single hop that never touches Odoo on a move.
//
// ISOMORPHIC BY CONTRACT — no `$lib`, no `$env`. wrangler bundles this outside
// the SvelteKit build where neither resolves; `check:noenv` enforces it.
import { stateView, resolveClaims, filterPickRows } from '../shared/gamelogic.js';
import {
	migrate, kvGet, kvSet, seedSequence,
	appendEvent, eventsFor, newestFor, headSeq, oldestSeq, trim, rowsOfType,
	REPLAY_MAX
} from './schema.js';
import { welcome, stateFrame, eventFrame, rosterFrame, aimFrame, ackFrame, errFrame, uptoOf, hasGap, CLOSE } from './frames.js';
import { hydrate, recentEvents, writeStateBack, archiveEvents, touchLastSeen } from './odoo-bridge.js';
import { publicRoom, publicMembers } from '../shared/roomview.js';

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

/* Ops that make this object the source of truth, and therefore have to run the
   one-way ownership transfer first. Everything else — pushes from routes that
   still write Odoo themselves, roster updates, ephemeral aim — must NOT trigger
   it, or a room would flip the moment somebody merely spoke in chat. */
const OWNING_OPS = new Set(['setState', 'append', 'thiefPick']);

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
	/**
	 * Load the room from Odoo exactly once, before anything can observe an empty
	 * object.
	 *
	 * blockConcurrencyWhile is what makes "exactly once" true: without it a room
	 * that gets two simultaneous joins would hydrate twice, and the second would
	 * overwrite state the first had already started mutating.
	 *
	 * The roomId comes from the caller because the DO knows its own id only as an
	 * opaque hash — idFromName is one-way.
	 */
	async ensureHydrated(roomId) {
		if (kvGet(this.sql, 'hydrated_at')) return true;
		let ok = false;
		await this.ctx.blockConcurrencyWhile(async () => {
			if (kvGet(this.sql, 'hydrated_at')) { ok = true; return; }
			const data = await hydrate(this.env, roomId);
			if (!data) return; // room is gone — leave unhydrated so we retry
			kvSet(this.sql, 'room_id', Number(roomId));
			kvSet(this.sql, 'room', publicRoom(data.row));
			kvSet(this.sql, 'members', publicMembers(data.members));
			kvSet(this.sql, 'members_raw', data.members);
			if (data.state) kvSet(this.sql, 'state', data.state);
			// MUST happen before any event is appended: clients hold chat keyed by
			// Odoo event ids, so a DO minting from 1 would collide with keys already
			// in their store — a duplicate-key crash in a keyed {#each}.
			seedSequence(this.sql, data.maxEventId);
			kvSet(this.sql, 'hydrated_at', Date.now());
			ok = true;
		});
		return ok;
	}

	/**
	 * Take ownership of the room's state and event log. One-way, once per room.
	 *
	 * This is the instant the source of truth moves, and it has to be exactly an
	 * instant — everything below runs inside blockConcurrencyWhile so no request
	 * can observe a room that is half transferred.
	 *
	 * Three things happen here that CANNOT be folded into ensureHydrated:
	 *
	 * 1. A FRESH Odoo read. Before ownership, `kv.state` is only whatever the last
	 *    doApply({op:'state'}) delivered — and doApply is best-effort by design,
	 *    logging and swallowing failures (see server/realtime.js). Promoting a
	 *    dropped push to source-of-truth would silently roll the game back. Odoo is
	 *    still authoritative at this moment, so we re-read it.
	 * 2. Backfilling the tail of Odoo's event log. From here the DO's log is the
	 *    only log: it serves the poll, it answers `hello`, and it is what
	 *    resolveClaims rebuilds the thief-finder claim map from. Starting empty
	 *    would show a joiner an empty room and re-deal envelopes mid-draw.
	 * 3. Re-seeding the sequence above Odoo's highest id, so DO-minted ids can
	 *    never collide with the ones clients already hold as chat keys.
	 *
	 * Rooms that hydrated during M2.3 are already past ensureHydrated's early
	 * return, which is exactly why this cannot ride on hydration.
	 */
	async ensureOwned(roomId) {
		if (kvGet(this.sql, 'owns_state')) return true;
		let ok = false;
		await this.ctx.blockConcurrencyWhile(async () => {
			if (kvGet(this.sql, 'owns_state')) { ok = true; return; }
			const id = Number(roomId) || kvGet(this.sql, 'room_id');
			if (!id) return;

			const [data, recent] = await Promise.all([
				hydrate(this.env, id),
				recentEvents(this.env, id, REPLAY_MAX)
			]);
			if (!data) return; // room is gone — stay unowned and let the caller fail

			kvSet(this.sql, 'room_id', id);
			kvSet(this.sql, 'room', publicRoom(data.row));
			kvSet(this.sql, 'members', publicMembers(data.members));
			kvSet(this.sql, 'members_raw', data.members);
			kvSet(this.sql, 'state', data.state ?? { v: 0, voice: [], game: null });

			// EVERYTHING ALREADY IN THE LOG CAME FROM ODOO, so none of it is owed
			// back. Rows arrive here two ways and both are already durable: the
			// backfill below, and the `{op:'event'}` pushes M2.3 has been delivering
			// since hydrate — those carry the id of a row the ROUTE created in Odoo.
			// Once owns_state flips, flush() starts archiving anything marked
			// archived = 0, so without this line the transfer would re-create every
			// event the room had pushed since it woke, duplicating chat history in
			// the archive. The pre-ownership flush marks rows as it goes; this covers
			// whatever arrived since the last one.
			this.sql.exec('UPDATE events SET archived = 1 WHERE archived = 0');
			// archived: 1 — same reasoning, for the rows we are about to pull in.
			for (const r of recent) appendEvent(this.sql, { ...r, archived: 1 });
			seedSequence(this.sql, Math.max(data.maxEventId, headSeq(this.sql)));

			kvSet(this.sql, 'owns_state', 1);
			kvSet(this.sql, 'owned_at', Date.now());
			ok = true;
		});
		return ok;
	}

	/**
	 * Hand the room back to the HTTP/Odoo path. The M2.4 rollback.
	 *
	 * IT MUST REFUSE TO COMPLETE UNTIL THE FLUSH SUCCEEDS. That is the whole
	 * difference between a rollback and a data-loss button: once `evacuated` is
	 * set, every subsequent op is rejected and the dispatcher falls back to Odoo,
	 * so anything still only in this object's storage would be gone. A failed
	 * flush leaves the room owned and serving, which is the recoverable outcome.
	 *
	 * Order matters: flush, THEN mark, THEN close. Marking first would let the
	 * flush's own writes race a route that has already fallen back.
	 */
	async evacuate() {
		if (kvGet(this.sql, 'evacuated')) return { ok: true, already: true };
		await this.flush();
		if (kvGet(this.sql, 'state_dirty_at')) {
			return { ok: false, error: 'flush incomplete — room stays on the DO' };
		}
		kvSet(this.sql, 'evacuated', 1);
		kvSet(this.sql, 'owns_state', 0);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(CLOSE.EVACUATED, 'evacuated');
			} catch {
				/* a socket that will not close must not block the rollback */
			}
		}
		return { ok: true };
	}

	async fetch(req) {
		const url = new URL(req.url);
		const roomId = Number(req.headers.get('x-room-id')) || kvGet(this.sql, 'room_id');
		if (roomId) await this.ensureHydrated(roomId);

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

			// The two ops that must await live HERE, ahead of apply(). apply() is
			// synchronous on purpose — an await between an insert and the last send()
			// is precisely what breaks the upto invariant — so anything needing Odoo
			// has to finish before it is entered, never inside it.
			if (op?.op === 'evacuate') return Response.json(await this.evacuate());
			if (OWNING_OPS.has(op?.op) && !kvGet(this.sql, 'evacuated')) {
				if (!(await this.ensureOwned(roomId))) {
					// Never fall through to a write on a room whose ownership could not
					// be established: that would make the DO's copy authoritative
					// without the fresh Odoo read that makes it correct.
					return Response.json({ ok: false, error: 'ownership transfer failed', code: 'not_owned' });
				}
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
		// One predicate for both transports — see frames.js hasGap.
		const gap = hasGap(cursor, oldestSeq(this.sql));
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
	broadcastState(state) {
		const cache = new Map();
		for (const ws of this.ctx.getWebSockets()) {
			const { uid } = ws.deserializeAttachment() ?? {};
			if (!uid) continue;
			if (!cache.has(uid)) cache.set(uid, JSON.stringify(stateFrame(stateView(state, uid))));
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
			case 'snapshot':
				// Serves the reads a mutation used to make against Odoo: the room row,
				// the member list and the state blob. This is the call that takes a
				// move off the ~1 req/s Odoo budget.
				return {
					ok: true,
					room: kvGet(this.sql, 'room'),
					members: this.membersWithPresence(),
					raw: kvGet(this.sql, 'members_raw', []),
					state: kvGet(this.sql, 'state'),
					owns: !!kvGet(this.sql, 'owns_state')
				};
			case 'events': {
				// The HTTP fallback poll, served from here instead of Odoo. Same page
				// size and same oldest-first order as the query it replaces, so the
				// envelope the route builds around it is unchanged.
				const uid = Number(op.uid);
				const since = Number(op.since) || 0;
				// The client cannot tell "trimmed away" from "nothing new", and a
				// cursor that jumps to the newest returned id would leave a block of
				// chat silently missing. `gap` is the HTTP path's `resync`, and it is
				// the SAME predicate the socket uses — see frames.js hasGap.
				const gap = hasGap(since, oldestSeq(this.sql));
				const events = gap ? newestFor(this.sql, uid) : eventsFor(this.sql, uid, since);
				return {
					ok: true,
					events,
					// uptoOf, not headSeq: targeted signals are filtered out of `events`
					// for everyone but their recipient, so the head can cover an event
					// this caller was never entitled to and will never refetch.
					cursor: uptoOf(events, gap ? 0 : since),
					gap
				};
			}
			case 'setState': {
				// The authoritative write. The version is bumped HERE, inside the
				// object, which is what removes the read-modify-write race the Odoo
				// path needed guardVersion for: a DO is single-threaded per room, so
				// "read, bump, write" cannot interleave with another writer.
				const cur = kvGet(this.sql, 'state');
				// Optional compare-and-set, for the callers whose precondition means
				// "this action must not happen at all" rather than "order it" (see
				// stillValid in server/room.js). The caller evaluated its predicate
				// against the version it names here; if the state moved in between,
				// that verdict is stale and the write is refused rather than applied.
				if (op.expectV != null && (Number(cur?.v) || 0) !== Number(op.expectV)) {
					return { ok: false, status: 409, code: 'conflict', error: 'Someone else just changed this — try again' };
				}
				const next = op.state ?? {};
				next.v = Math.max(Number(cur?.v) || 0, Number(next.v) || 0) + (op.bump === false ? 0 : 1);
				kvSet(this.sql, 'state', next);
				this.broadcastState(next);
				this.markDirty();
				return { ok: true, state: next, v: next.v };
			}
			case 'append': {
				// Mint the id here so a move costs no Odoo create. Safe because the
				// sequence was seeded above Odoo's highest id at the ownership transfer.
				const seq = this.applyEvent({ ...op.event, id: null }, op.targetUid ?? null);
				return { ok: true, id: seq };
			}
			case 'thiefPick':
				return this.thiefPick(op);
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
		this.broadcastState(state);
		this.markDirty();
	}

	applyRoster(room, members) {
		if (room) kvSet(this.sql, 'room', room);
		if (members) kvSet(this.sql, 'members', members);
		this.broadcastRoster();
	}

	/**
	 * A thief-finder envelope pick: validate, append, re-resolve the whole claim
	 * map from the log, persist and push — as ONE synchronous step.
	 *
	 * This is the route that several players hit at the same instant; that IS the
	 * game. On the Odoo path it was three round trips (append, re-read the pick
	 * log, write) with other players interleaving freely, which is what
	 * guardVersion and the poll's self-heal existed to paper over — and they only
	 * ever ordered the damage, they could not prevent it.
	 *
	 * Here the object is single-threaded and nothing below awaits, so no second
	 * pick can observe or interleave with a half-applied one. guardVersion is
	 * therefore not merely unnecessary, it is meaningless: there is no window.
	 *
	 * resolveClaims/filterPickRows are the same shared, pure functions the Odoo
	 * path uses, fed the same row shape by rowsOfType — one arbiter, two stores.
	 */
	thiefPick({ uid, envelope }) {
		const player = Number(uid);
		const state = kvGet(this.sql, 'state');
		const game = state?.game;
		if (!game || game.type !== 'thief_finder') {
			return { ok: false, status: 409, error: 'No thief-finder game in progress' };
		}
		if (game.phase !== 'picking') return { ok: false, status: 409, error: 'Not in the picking phase' };
		if (!game.players.includes(player)) return { ok: false, status: 403, error: 'You are not a player' };
		const k = Number(envelope);
		if (!Number.isInteger(k) || k < 0 || k >= game.players.length) {
			return { ok: false, status: 400, error: 'No such envelope' };
		}
		// Exact here, not the best-effort fast reject the route had to settle for:
		// the claim map cannot move under us.
		if (game.claims?.[k] != null && game.claims[k] !== player) {
			return { ok: false, status: 409, code: 'taken', error: 'Envelope already taken' };
		}

		this.applyEvent({
			id: null,
			type: 'pick',
			senderUid: player,
			payload: { epoch: game.epoch, draw: game.draw, envelope: k }
		});
		// `game` is a live reference into `state`, so this mutates what we persist.
		resolveClaims(game, filterPickRows(rowsOfType(this.sql, 'pick'), game));
		state.v = (Number(state.v) || 0) + 1;
		kvSet(this.sql, 'state', state);
		this.broadcastState(state);
		this.markDirty();
		return { ok: true, state, v: state.v };
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

		if (this.isDue('next_archive_at', now)) {
			kvSet(this.sql, 'next_archive_at', 0);
			await this.flush();
		}

		if (this.isDue('next_heartbeat_at', now)) {
			kvSet(this.sql, 'next_heartbeat_at', 0);
			await this.heartbeat();
		}

		if (sockets === 0 && this.isDue('next_idle_at', now)) {
			kvSet(this.sql, 'next_idle_at', 0);
			// Drain before going quiet: after this there is no timer to come back on.
			await this.flush();
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

	/* ---- write-behind ------------------------------------------------------
	   Odoo is the archive now, not the source of truth. Nothing here is on a
	   move's critical path — a failure means the durable copy lags, which the
	   next alarm retries, not that a player is blocked. */

	async flush() {
		const roomId = kvGet(this.sql, 'room_id');
		if (!roomId) return;
		let clean = true;

		// State write-back is gated on OWNERSHIP, not just on having a copy.
		// While the HTTP routes still own state they write it to Odoo themselves,
		// and this alarm holds whatever doApply last delivered. Those can interleave:
		// route writes v6, the v6 push has not landed yet, the alarm fires holding
		// v5 — and Odoo regresses. Until `owns_state` is set (M2.4b), the DO's copy
		// is a cache for pushing, never a source to persist from.
		const state = kvGet(this.sql, 'state');
		if (kvGet(this.sql, 'owns_state') && state && kvGet(this.sql, 'state_dirty_at')) {
			try {
				await writeStateBack(this.env, roomId, state);
			} catch (e) {
				console.error(`flush: state write failed for room ${roomId}:`, e?.message);
				clean = false;
			}
		}

		// Oldest first, so a partial drain leaves a prefix rather than holes.
		// Events are append-only, so archiving them has none of the overwrite risk
		// state does — but while the routes still own the log they already created
		// the Odoo row, and re-creating it here would double every message. Mark
		// those as archived without writing.
		const owns = !!kvGet(this.sql, 'owns_state');
		const pending = owns
			? [...this.sql.exec(
					'SELECT seq, type, sender, target, payload FROM events WHERE archived = 0 ORDER BY seq ASC LIMIT 200'
				)]
			: [];
		if (!owns) this.sql.exec('UPDATE events SET archived = 1 WHERE archived = 0');
		if (pending.length) {
			const written = await archiveEvents(this.env, roomId, pending);
			for (const r of pending.slice(0, written)) {
				this.sql.exec('UPDATE events SET archived = 1 WHERE seq = ?', r.seq);
			}
			if (written < pending.length) clean = false;
		}

		// Only clear the dirty marker on a FULL drain. Clearing it optimistically
		// would stop the alarm chain re-arming and strand whatever failed.
		if (clean) kvSet(this.sql, 'state_dirty_at', 0);
		else this.armAlarms();
	}

	/**
	 * Keep last_seen fresh for connected players.
	 *
	 * Load-bearing once the poll is gone: presence used to ride the poll, and
	 * sweepAbandonedRooms deletes any room whose members all look stale. Without
	 * this, a room full of people talking over sockets would be reaped.
	 */
	async heartbeat() {
		const roomId = kvGet(this.sql, 'room_id');
		const raw = kvGet(this.sql, 'members_raw', []);
		const live = [...this.liveUids()];
		if (!roomId || !raw?.length || !live.length) return;
		try {
			await touchLastSeen(this.env, roomId, raw, live);
		} catch (e) {
			console.error(`heartbeat failed for room ${roomId}:`, e?.message);
		}
	}
}

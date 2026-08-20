// One Durable Object per room: authoritative game state plus every player's
// WebSocket, co-located. Replaces "browser -> Worker -> Odoo -> Ably -> browser"
// with a single hop that never touches Odoo on a move.
//
// ISOMORPHIC BY CONTRACT — no `$lib`, no `$env`. wrangler bundles this outside
// the SvelteKit build where neither resolves; `check:noenv` enforces it.
import {
	stateView, resolveClaims, filterPickRows, syncVoiceSince, VOICE_CAP,
	applySudokuFill, applyMatch3Finish, closeMatch3
} from '../shared/gamelogic.js';
import {
	migrate, kvGet, kvSet, seedSequence,
	appendEvent, eventsFor, newestFor, chatBefore, headSeq, oldestSeq, trim, rowsOfType,
	REPLAY_MAX
} from './schema.js';
import { welcome, stateFrame, eventFrame, rosterFrame, aimFrame, tickFrame, moveFrame, ackFrame, errFrame, uptoOf, hasGap, withSeq, CLOSE } from './frames.js';
import { hydrate, recentEvents, roomExists, writeStateBack, archiveEvents, touchLastSeen } from './odoo-bridge.js';
import { publicRoom, publicMembers, withPresence } from '../shared/roomview.js';

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
/* How often a failing object may spend one read asking "does this room still
   exist?".
   A TIMESTAMP, NOT A FAILURE COUNT. The count version did not work: production
   showed flushFails pinned at 2 and the check never firing, because more than
   one path resets it and the object never accumulated three in a row. A deadline
   cannot be reset by a well-meaning success elsewhere — it only moves forward —
   which is the property this needs. Five minutes bounds the cost to one read per
   object per five minutes even during a full Odoo outage. */
const ORPHAN_CHECK_EVERY_MS = 300_000;

/* Ops that make this object the source of truth, and therefore have to run the
   one-way ownership transfer first. Everything else — pushes from routes that
   still write Odoo themselves, roster updates, ephemeral aim — must NOT trigger
   it, or a room would flip the moment somebody merely spoke in chat. */
// `tick` is deliberately absent: it is ephemeral score chatter, and letting it
// flip a room to source-of-truth would transfer ownership on a frame that writes
// nothing — the same reason chat and aim are not here.
const OWNING_OPS = new Set(['setState', 'append', 'thiefPick', 'voice', 'sudokuFill', 'match3Finish']);

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
	 *
	 * blockConcurrencyWhile around the flush-and-mark is what makes the promise
	 * above actually true. flush() awaits Odoo, and a setState landing in that
	 * window calls markDirty() — which is a NO-OP when state_dirty_at is already
	 * set. flush then clears the marker on its way out, the check below passes,
	 * and that write is gone with no alarm left to retry it. Holding the object
	 * across both means there is no window for an op to land in.
	 */
	async evacuate() {
		if (kvGet(this.sql, 'evacuated')) return { ok: true, already: true };
		let drained = false;
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.flush();
			// Only a FULL drain clears this; anything still owed leaves the room owned
			// and serving, which is the recoverable outcome.
			if (kvGet(this.sql, 'state_dirty_at')) return;
			kvSet(this.sql, 'evacuated', 1);
			kvSet(this.sql, 'owns_state', 0);
			drained = true;
		});
		if (!drained) return { ok: false, error: 'flush incomplete — room stays on the DO' };
		// Outside the block on purpose: `evacuated` is set, so apply() already
		// rejects everything and there is nothing left to race.
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
				evacuated: !!kvGet(this.sql, 'evacuated'),
				// The three that explain a misbehaving object without guesswork:
				// whether it is the writer, how long its flush has been failing, and
				// how much is still owed to Odoo.
				owns: !!kvGet(this.sql, 'owns_state'),
				flushFails: kvGet(this.sql, 'flush_fails', 0),
				unarchived: [...this.sql.exec('SELECT COUNT(*) AS n FROM events WHERE archived = 0')][0]?.n ?? 0,
				nextArchiveAt: kvGet(this.sql, 'next_archive_at', 0),
				nextIdleAt: kvGet(this.sql, 'next_idle_at', 0),
				roomId: kvGet(this.sql, 'room_id')
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
			if (op?.op === 'destroy') {
				await this.destroy();
				return Response.json({ ok: true });
			}
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

		// The match-3 score ticker. Ephemeral for the same reason `aim` is: it
		// fires every few seconds per player for 90 seconds and nothing durable
		// rides on it — the authoritative score arrives once, at the finish.
		// Routing it through the state version instead would bump `state.v` for
		// pixels and thrash every client's merge gate.
		if (msg.t === 'tick') {
			this.broadcast(tickFrame({ ...msg.data, uid }), (u) => u !== uid);
			return;
		}

		// Hide & Fire player transform. Ephemeral for the same reason as aim/tick:
		// it fires ~15/s per player and only drives how peers render the moving
		// puppet; kills and scores travel the durable state path instead.
		if (msg.t === 'move') {
			this.broadcast(moveFrame({ ...msg.data, uid }), (u) => u !== uid);
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
		this.onSocketGone(ws);
	}

	async webSocketError(ws) {
		this.onSocketGone(ws);
	}

	/**
	 * A socket went away. Presence changes, and so may the voice roster.
	 *
	 * DROPPING THEM FROM VOICE HERE IS WHAT REPLACES pruneStaleVoice. That helper
	 * inferred voice ghosts from a 90-second staleness window because nothing
	 * better existed — it ran on a READ endpoint, wrote state, and could not tell
	 * "tab closed" from "slow network". A closed socket is the real signal, and it
	 * arrives in milliseconds.
	 *
	 * Only when the uid has NO sockets left: two tabs are ordinary, and closing
	 * one must not hang up the call being held in the other. `getWebSockets` still
	 * includes the closing socket during this callback in some runtimes, so the
	 * check excludes it explicitly rather than trusting the count.
	 */
	onSocketGone(ws) {
		const { uid } = ws.deserializeAttachment() ?? {};
		if (uid && !this.ctx.getWebSockets(`u:${uid}`).some((s) => s !== ws)) {
			this.mutateVoice(uid, 'leave');
		}
		// Presence is derived from live sockets, so a close changes the roster.
		this.broadcastRoster();
		this.armAlarms();
	}

	/**
	 * THE ONLY WAY THE VOICE ROSTER EVER CHANGES. Mutates `voice`/`voiceSince` and
	 * nothing else.
	 *
	 * `voice` used to travel inside the state blob, which meant every route that
	 * merely READ the blob and wrote it back could erase a join that landed in
	 * between — end/rematch/game-type all run Odoo writes in that window, and they
	 * run in the lobby, which is exactly where people press Join voice. The erasure
	 * was silent: the clobbering write lands at a higher version, so every client
	 * accepts it as the newest truth and the dropped player has no way to tell.
	 *
	 * So the roster moved out of the blob and behind this method — see the note in
	 * the `setState` case, which is the other half and only works with this one.
	 * A socket closing (onSocketGone) and a player pressing the button both land
	 * here, so the two can never drift.
	 *
	 * Idempotent in both directions, and a no-op does NOT bump the version: a
	 * second `leave` for someone already gone must not push a frame to the room.
	 * `changed` is what the route gates its "joined voice" announcement on, so a
	 * client re-entering a roster it is already in stays silent.
	 *
	 * Returns `{ state, changed }`, `{ full: true }` when a join would exceed the
	 * cap, or `null` when the room has no state at all.
	 */
	mutateVoice(uid, action) {
		const state = kvGet(this.sql, 'state');
		if (!state) return null;
		const voice = state.voice || [];
		const present = voice.includes(uid);

		if (action === 'join') {
			if (present) return { state, changed: false };
			// Checked HERE, not by the caller against a blob it read a round trip ago:
			// the object is single-threaded, so two joins arriving together cannot both
			// pass a cap they are the same read of.
			if (voice.length >= VOICE_CAP) return { full: true };
			state.voice = [...voice, uid];
		} else {
			if (!present) return { state, changed: false };
			state.voice = voice.filter((u) => u !== uid);
		}

		syncVoiceSince(state); // dropping under two people ends the call
		state.v = (Number(state.v) || 0) + 1;
		kvSet(this.sql, 'state', state);
		this.broadcastState(state);
		this.markDirty();
		return { state, changed: true };
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
					gap,
					// Empty replay only: without it a quiet room's client never leaves
					// cursor 0 and re-takes the newestFor branch above on every reconnect.
					uptoFloor: gap ? 0 : Math.max(cursor, headSeq(this.sql))
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

	/**
	 * The roster, with presence decided NOW rather than whenever it was stored.
	 *
	 * `kv.members` is publicMembers output written at the last roster push, so its
	 * `online` is a frozen verdict — re-serving it would show someone online for
	 * as long as the room lived. withPresence re-decides from the `lastSeen` that
	 * travelled with each row, unioned with the sockets open at this instant.
	 *
	 * The union is what keeps HTTP-fallback players visible: they hold no socket,
	 * so socket-only presence would render them offline to everyone including
	 * themselves.
	 */
	membersWithPresence() {
		return withPresence(kvGet(this.sql, 'members', []) ?? [], this.liveUids());
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
					// THE CALLER MUST CHECK THIS. Until the transfer, this object's log
					// holds only the pushes delivered since it woke — Odoo holds the
					// room's actual history, and answering from here would show a client
					// opening a room with a year of chat an empty one. `owns` is the exact
					// discriminator rather than a heuristic: `append` is an owning op, so
					// while this is false no DO-minted id exists anywhere and Odoo is
					// complete by construction.
					owns: !!kvGet(this.sql, 'owns_state'),
					// Who holds a socket right now. The HTTP poll cannot know this and
					// would otherwise render presence from last_seen alone — up to 90
					// seconds behind the roster frames the same room sees on the wire.
					// Free: this call was already being made for the events.
					liveUids: [...this.liveUids()],
					events,
					/* uptoOf, not headSeq: targeted signals are filtered out of `events`
					   for everyone but their recipient, so a PARTIAL replay must never
					   claim the head — that is the invariant doseq-check asserts, and
					   stamping the head is how the voice dropouts happened.

					   The empty case is different and is the one fixed here. Falling back
					   to `since` left a client that asked from 0 and matched nothing
					   pinned at 0 forever, so every reconnect re-took the DO's
					   `cursor === 0` branch and re-sent the newest 200 rows. When the
					   filter returned NOTHING there is nothing to step over: the head is
					   a server-computed watermark from the same synchronous op that did
					   the filtering, so "you have everything you are entitled to up to
					   here" is exactly true. apply() is serialized, so no append can
					   interleave between the query and this read.

					   Branch, NOT uptoOf's floor arg: that seeds the running max, so a
					   floor above the delivered ids would win and a partial replay would
					   claim the head. */
					cursor: events.length
						? uptoOf(events)
						: gap
							? 0
							: Math.max(since, headSeq(this.sql)),
					gap
				};
			}
			case 'chat': {
				// One page of chat history, independent of the event cursor. `owns` is
				// reported for the same reason the events op reports it: before the
				// transfer this log holds only what arrived since the object woke, and
				// Odoo is the complete archive — the caller has to know which it got.
				const limit = Math.min(Math.max(Number(op.limit) || 30, 1), 100);
				const messages = chatBefore(this.sql, Number(op.before) || 0, limit + 1);
				// Ask for one extra to answer "is there more?" without a second query.
				const more = messages.length > limit;
				return {
					ok: true,
					owns: !!kvGet(this.sql, 'owns_state'),
					messages: more ? messages.slice(1) : messages,
					more
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
				/* THE VOICE ROSTER IS NOT THE CALLER'S TO SEND, and this line is the
				   whole reason a join stopped vanishing between games.

				   Every route reads the state blob at the top of the request and writes
				   it back at the bottom, with Odoo round trips in between (resetRound,
				   reseatRoles). `voice` used to ride inside that blob, so a join that
				   landed in the window was overwritten by a route that had nothing to do
				   with voice — and the reverse: someone the object dropped on a socket
				   close was resurrected, which is how a room reached VOICE_CAP with
				   nobody in the call.

				   Taking it from `cur` instead makes those writes structurally incapable
				   of touching it. mutateVoice is the only writer; see the note there.
				   Falls back to the incoming blob only when there is no `cur` at all —
				   a room whose very first write this is. */
				if (cur) {
					next.voice = cur.voice ?? [];
					next.voiceSince = cur.voiceSince ?? null;
				}
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
			case 'voice': {
				// The roster's own op, so a join or a leave never has to send — and
				// therefore never has to re-send — the rest of the state blob. That
				// cuts the mirror race too: joining voice mid-game used to write back
				// a `game` read before the last move.
				const uid = Number(op.uid);
				if (!Number.isInteger(uid) || uid <= 0) return { ok: false, status: 400, error: 'bad uid' };
				if (op.action !== 'join' && op.action !== 'leave') {
					return { ok: false, status: 400, error: 'Invalid action' };
				}
				const res = this.mutateVoice(uid, op.action);
				if (res?.full) {
					return { ok: false, status: 409, code: 'voice_full', error: 'Voice is full — text chat only' };
				}
				if (!res) return { ok: false, status: 409, error: 'The room has no state yet' };
				return { ok: true, state: res.state, v: res.state.v, changed: res.changed };
			}
			case 'thiefPick':
				return this.thiefPick(op);
			case 'sudokuFill':
				return this.raceWrite('sudoku', (game) =>
					applySudokuFill(game, Number(op.uid), op.cell, op.digit)
				);
			case 'match3Finish':
				return this.raceWrite('match3', (game) => {
					const res = applyMatch3Finish(game, Number(op.uid), op.report);
					/* Then try to close the round, EVEN IF the report above was refused.
					   A player who already reported comes back once after the grace
					   window precisely to trigger this, and that second call is the only
					   thing that ends a round somebody never reported into — there is no
					   alarm here by design. `closeMatch3` is itself a no-op before the
					   grace window and after the round has ended, so this is safe to
					   call on every request. */
					const closed = closeMatch3(game);
					if (res.ok || closed) return { ...res, ok: true, closed };
					return res;
				});
			case 'tick':
				// Ephemeral, exactly like `aim`: the match-3 score ticker. No seq, no
				// storage, no ack, no state version — see the note on the socket path.
				this.broadcast(tickFrame(op.data), (u) => u !== Number(op.data?.uid));
				return { ok: true };
			case 'aim':
				// Ephemeral: no seq, no storage, no ack. Echoes to everyone but the
				// shooter, who is already rendering their own drag locally.
				this.broadcast(aimFrame(op.data), (u) => u !== Number(op.data?.uid));
				return { ok: true };
			case 'move':
				// Ephemeral Hide & Fire transform — same contract as aim/tick. Echoes
				// to everyone but the mover, who renders their own view locally.
				this.broadcast(moveFrame(op.data), (u) => u !== Number(op.data?.uid));
				return { ok: true };
			case 'kick':
				this.kick(op.uid);
				return { ok: true };
			// 'destroy' and 'evacuate' are NOT here — both await, and this switch is
			// await-free on purpose (the upto invariant). They are intercepted in
			// fetch() before it is entered.
			default:
				return { ok: false, error: `unknown op ${op?.op}` };
		}
	}

	/**
	 * Wipe everything and stop. Used when the room is deleted upstream.
	 *
	 * `deleteAll()` DROPS THE TABLES, it does not merely empty them — every
	 * subsequent kvGet on this instance throws "no such table: kv" until the
	 * object is evicted and the constructor's migrate runs again. So re-migrate
	 * here and leave a valid, empty object behind. (Verified in
	 * worker-test/destroy.test.js; assuming rows-not-tables is the natural
	 * reading and it is wrong.)
	 *
	 * The alarm goes with it. Without that, a pending archive fires into an empty
	 * object minutes later, tries to write a room Odoo no longer has, fails, and
	 * re-arms itself — one doomed Odoo call every 15 seconds, forever, against a
	 * budget the whole app shares. An orphan that never stops is worse than one
	 * that never runs.
	 */
	async destroy() {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(CLOSE.KICKED, 'room deleted');
			} catch {
				/* ignore */
			}
		}
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		migrate(this.sql);
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
		// `id` LAST, and this is load-bearing. It used to be written first and then
		// spread over — which was invisible while every event carried an Odoo id,
		// because `event.id` and `seq` were the same number. The `append` op passes
		// `id: null` (the object mints its own), so the spread overwrote the minted
		// seq with null and every socket-delivered chat message arrived keyed on
		// null: a duplicate key in the client's keyed {#each}, which is the crash
		// the whole id-seed exists to prevent, arriving from the other direction.
		const frame = eventFrame(withSeq(event, seq), seq);
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

	/**
	 * One player's write into a race game, applied and published as ONE step.
	 *
	 * The race games are the second place several players write at the same
	 * instant — but unlike thief-finder's envelope grab, each of them writes only
	 * their OWN sub-state (`boards[uid]` / `scores[uid]`). Two writes can never
	 * describe conflicting futures, so there is nothing to rank and
	 * `contendedProgress` deliberately does not cover them (see games.js).
	 *
	 * What makes that safe is the same property thiefPick relies on: the object is
	 * single-threaded and nothing below awaits, so no second fill can observe or
	 * interleave with a half-applied one. guardVersion would be meaningless here
	 * for exactly the reason given there — there is no window.
	 *
	 * `apply` is the shared arbiter from shared/gamelogic.js, the same function
	 * the /api route calls, so the two stores cannot drift.
	 */
	raceWrite(type, apply) {
		const state = kvGet(this.sql, 'state');
		const game = state?.game;
		if (!game || game.type !== type) {
			return { ok: false, status: 409, error: `No ${type} game in progress` };
		}

		// `game` is a live reference into `state`, so this mutates what we persist.
		const res = apply(game);
		// A refused write changed nothing — do not burn a version or a broadcast on
		// it, or a frozen player mashing keys would fan out to the whole room.
		if (!res.ok) return res;

		state.v = (Number(state.v) || 0) + 1;
		kvSet(this.sql, 'state', state);
		this.broadcastState(state);
		this.markDirty();
		return { ...res, state, v: state.v };
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

	/** Archive retry interval: 15s, doubling per consecutive failure, capped at 10m. */
	archiveBackoffMs() {
		const fails = Number(kvGet(this.sql, 'flush_fails', 0)) || 0;
		return Math.min(ARCHIVE_MS * 2 ** Math.min(fails, 6), 600_000);
	}

	/* ---- alarms ----------------------------------------------------------- */

	armAlarms() {
		const now = Date.now();
		const sockets = this.ctx.getWebSockets().length;
		const dirty = !!kvGet(this.sql, 'state_dirty_at');

		const due = [];
		// Back the archive off exponentially while it keeps failing. Odoo being
		// down, or a room deleted underneath us, would otherwise mean a doomed call
		// every 15 seconds for as long as the object exists — against the ~1 req/s
		// budget the whole app shares. Capped, and reset to ARCHIVE_MS the moment a
		// flush drains cleanly, so an ordinary blip costs nothing.
		if (dirty) due.push(this.ensureDue('next_archive_at', now + this.archiveBackoffMs()));
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
		if (clean) {
			kvSet(this.sql, 'state_dirty_at', 0);
			kvSet(this.sql, 'flush_fails', 0);
			return;
		}

		/* ORPHAN SELF-HEAL.
		   A room deleted upstream leaves an object that can never drain: every
		   archive write targets rows Odoo no longer has, fails, and re-arms — so it
		   never hibernates and spends the shared Odoo budget forever. deleteRoom
		   now sends `destroy`, but that only covers deletes that REACH the object;
		   a transient failure there, or any room deleted before that wiring
		   existed, still strands one. Measured, not theoretical: six orphans
		   accumulated from six probe runs inside an hour, each retrying every 15s.

		   So after a few consecutive failures, spend ONE read asking whether the
		   room still exists. Gone means this object has nothing left to do and
		   should stop existing; still there means Odoo is merely unhappy, and the
		   backoff above carries it. */
		kvSet(this.sql, 'flush_fails', (Number(kvGet(this.sql, 'flush_fails', 0)) || 0) + 1);

		const now = Date.now();
		if (now >= Number(kvGet(this.sql, 'next_orphan_check_at', 0) || 0)) {
			// Set the next deadline BEFORE the await, so a check that throws still
			// counts as an attempt and cannot turn into a retry loop of its own.
			kvSet(this.sql, 'next_orphan_check_at', now + ORPHAN_CHECK_EVERY_MS);
			try {
				if (!(await roomExists(this.env, roomId))) {
					console.log(`room ${roomId} is gone from Odoo — destroying the orphaned object`);
					await this.destroy();
					return; // storage is wiped; there is nothing left to re-arm for
				}
			} catch (e) {
				// The check ITSELF failing means Odoo is unreachable rather than the
				// room being gone — exactly when NOT to self-destruct, because that
				// would discard unflushed state during an ordinary outage.
				console.error(`orphan check failed for room ${roomId}:`, e?.message);
			}
		}
		this.armAlarms();
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

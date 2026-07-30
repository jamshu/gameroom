// Room poll loop: one consolidated GET drives chat, presence, voice roster,
// game state and WebRTC signaling.
//
// Cadence is three-tier. The remaining latency in the room is *discovery* — you
// only learn about someone else's move on your next poll — so the tiers are
// tuned around that. Note the idle tier deliberately needs 30s of total silence:
// the changes you most want promptly tend to FOLLOW a lull (the police thinks,
// then guesses), so backing off after a few quiet seconds would slow down
// exactly the moments that matter.
import { writable, get } from 'svelte/store';
import { api, POLL_TIMEOUT_MS } from '$lib/api.js';
import { outranksAtSameVersion } from '$lib/games.js';

// Budget, not preference: Odoo Online rate-limits per IP at roughly 1 req/s, and
// every poll costs 3 Odoo calls shared across the whole room. A 4-player room at
// 2.5s already runs ~5 req/s, so these are the slowest values that still feel
// like a game — pushing ACTIVE down to 800ms earned a hard HTTP 429.
const ACTIVE_MS = 1500; // something changed just now — more probably will (was 1050: 429s)
const BASE_MS = 1500; // normal play
const IDLE_MS = 10000; // nothing at all for 30s — empty lobby, abandoned game
const ACTIVE_WINDOW_MS = 5000;
const IDLE_AFTER_MS = 30000;
const FAST_MS = 1000; // while WebRTC signaling is in flight
// When Ably push is connected, every actual change now arrives on the wire —
// state, events AND the room/member roster — so the poll is purely a safety net.
// It used to sit at 8s only because presence rode on it; the heartbeat and the
// `online` window in server/room.js were widened together to let this go up.
// These three numbers are coupled: this must stay under PRESENCE_WINDOW_MS there,
// or a player polling on schedule renders as offline to everyone else.
const PUSH_SAFETY_MS = 60000;
// Reasons the poll must give up rather than retry. Anything else is transient.
const TERMINAL_CODES = new Set(['removed', 'not_member']);
// Retry ladder while polls are failing — see cadence(). Deliberately NOT a
// multiplier on the normal tiers: recovery has to be fast even when the tier it
// would have multiplied is the 60s push safety net.
const ERROR_BASE_MS = 1500;
const ERROR_MAX_MS = 15000;
// One failure is a blip that the ladder above heals in ~1.5s. Warning about it
// is worse than staying quiet — the banner is what made a self-healing hiccup
// look like a broken game. Speak up once it's clearly not recovering.
const ERROR_QUIET_STREAK = 1;
// Deliberately NOT widened alongside the two above. `cadence()` tests
// document.hidden BEFORE `fast`, so this is also the tier a hidden tab
// negotiating WebRTC sits on when push is off — raising it would slow voice
// signaling on the fallback path, which this work is meant to leave untouched.
// Browsers throttle background timers anyway, so there was little to win.
const HIDDEN_MS = 10000;
// How long to wait after an event that implies state moved before reconciling.
// Not 0: a five-player picking round would otherwise fire a burst of polls at
// the shared ~1 req/s Odoo budget. Long enough for the state push that normally
// follows the event to land first, short enough that the fallback isn't the 60s
// safety net. Coupled to the debounce in reconcileSoon — one timer at a time.
const EVENT_RECONCILE_MS = 1200;
// Events the room renders entirely on their own. Everything else (`pick`,
// `system`) means the state blob moved, so seeing one without matching state is
// evidence we are behind.
const SELF_CONTAINED_EVENTS = new Set(['chat', 'signal']);

export function createRoomStore(roomId) {
	const store = writable({
		room: null,
		members: [],
		chat: [], // {id, senderUid, text}
		events: [], // system events (join/leave/draw results...) for the feed
		voice: [],
		voiceMs: null, // elapsed call time at the last server snapshot; null = no call
		voiceAt: null, // when that snapshot arrived, so the tick can extrapolate
		game: null,
		gv: 0,
		error: null,
		closed: false
	});

	let cursor = 0;
	let timer = null;
	let reconcileTimer = null; // see reconcileSoon()
	let stopped = false;
	let inFlight = false;
	let pendingImmediate = false; // an immediate poll was asked for mid-flight
	let fast = false;
	// A timestamp, never a boolean: a stuck "is active" flag is the classic
	// never-turns-off bug, whereas elapsed time is self-healing by construction.
	// Seeded to now so entering a room starts responsive.
	let lastActivityAt = Date.now();
	let errorStreak = 0; // consecutive failed polls — drives the backoff below
	let tempSeq = 0;
	let signalHandler = null; // webrtc manager subscribes here
	let systemHandler = null;
	let aimHandler = null; // carroms live striker/aim subscribes here
	let ably = null; // Ably Realtime client (null until/unless push is enabled)
	let channel = null;
	let pushConnected = false; // true while the wake-bell is live → poll backs off
	// Bumped whenever a POST response OR an Ably roster push hands us authoritative
	// room/members. Acts as the version gate those two rows don't otherwise have —
	// see poll().
	let roomEpoch = 0;
	// Rosters carry a server timestamp for the same reason: two pushes can arrive
	// out of order and there is no version field to compare.
	let lastRosterTs = 0;

	function onSignal(fn) {
		signalHandler = fn;
	}
	function onSystem(fn) {
		systemHandler = fn;
	}
	function onAim(fn) {
		aimHandler = fn;
	}

	/**
	 * Apply a `state` envelope onto a store snapshot, newest-wins.
	 *
	 * Write endpoints echo the caller's state back so an action doesn't cost an
	 * extra round trip — but a poll that STARTED before that POST can land after
	 * it carrying older state. The version gate is what stops the view flicking
	 * backwards; both paths must go through here.
	 *
	 * Equal versions are NOT automatically stale: two players opening envelopes at
	 * the same instant both persist v+1 from the same base, so the same version can
	 * carry different claim maps. A plain `<=` gate dropped whichever arrived
	 * second and the poll's own gate would never re-send it — a permanently frozen
	 * board. outranksAtSameVersion breaks those ties by round progress instead.
	 */
	function mergeState(s, state) {
		if (!state || state.v < s.gv) return s;
		if (state.v === s.gv && !outranksAtSameVersion(s.game, state.game)) return s;
		return {
			...s,
			voice: state.voice,
			// elapsed call time as measured BY THE SERVER at serialize time, plus the
			// moment it landed here — VoiceBar ticks forward from that pair rather
			// than differencing an absolute stamp against a possibly-skewed clock.
			voiceMs: state.voiceMs ?? null,
			voiceAt: state.voiceMs == null ? null : Date.now(),
			game: state.game ? { ...state.game, v: state.v } : null,
			gv: state.v
		};
	}

	// Event ids already applied — one guard shared by the poll and the Ably push,
	// so an event delivered by both (a poll in flight when the push lands) isn't
	// processed twice. Bounded so it can't grow without limit.
	// It only ever needs to hold ids ABOVE the poll cursor — anything at or below
	// it the poll will never ask for again. Sized well past the server's 200-row
	// page and any plausible burst between two polls, because now that the cursor
	// advances only on a poll (see ingest) every poll refetches what the push has
	// already delivered, and an evicted id would re-fire its system notice. Chat
	// has its own `seenChat` guard, so this is the only exposure.
	const APPLIED_IDS_MAX = 1000;
	const APPLIED_IDS_EVICT = 200;
	const appliedEventIds = new Set();
	function rememberApplied(id) {
		appliedEventIds.add(id);
		if (appliedEventIds.size > APPLIED_IDS_MAX) {
			const it = appliedEventIds.values();
			for (let i = 0; i < APPLIED_IDS_EVICT; i++) appliedEventIds.delete(it.next().value);
		}
	}

	/**
	 * The single apply path for BOTH the poll and the Ably push. Events dedupe by
	 * id; `state` merges version-gated; `room`/`members` update only when present
	 * (the push carries neither — presence still rides the poll).
	 */
	function ingest({ events = [], state, room, members }) {
		// `cursor` is deliberately NOT advanced here — only poll() moves it, from
		// the watermark the SERVER computed.
		//
		// It used to advance from any event, pushed ones included. But public
		// events arrive on `room:{id}` and targeted ones on `room:{id}:u:{uid}`,
		// two Ably channels with no ordering guarantee between them, while both
		// share this one cursor. A private `signal` with id 200 delivered ahead of
		// (or instead of) a public `chat` with id 199 pushed the cursor to 200, and
		// the next `?since=200` then skipped 199 permanently — a chat message or a
		// system notice silently lost, with the reconnect catch-up unable to help
		// because it asks from the highest id ever PUSHED at us rather than the
		// highest we actually have.
		//
		// The cost is that each poll refetches whatever the push already delivered
		// since the last one. That is bounded by the poll interval and the server's
		// 200-row limit, and appliedEventIds dedupes it — cheap next to losing a
		// message.
		const fresh = events.filter((ev) => ev && !appliedEventIds.has(ev.id));
		if (!fresh.length && !state && !room && !members) return;
		store.update((s) => {
			const chat = [...s.chat];
			const evs = [...s.events];
			const seenChat = new Set(chat.map((c) => c.id));
			for (const ev of fresh) {
				rememberApplied(ev.id);
				if (ev.type === 'chat') {
					if (seenChat.has(ev.id)) continue; // our own optimistic copy
					seenChat.add(ev.id);
					// the whole payload: text messages carry {text}, media ones
					// {kind, attId, mime, …} and an optional caption
					chat.push({ id: ev.id, senderUid: ev.senderUid, ...ev.payload });
				} else if (ev.type === 'signal') signalHandler?.(ev.senderUid, ev.payload);
				else if (ev.type === 'system') {
					evs.push(ev);
					systemHandler?.(ev);
				}
			}
			const next = { ...s, chat: trimChat(chat), events: evs.slice(-50), error: null };
			if (room) next.room = room;
			if (members) next.members = members;
			return mergeState(next, state);
		});
	}

	async function poll() {
		if (stopped) return;
		// A poll is already running — remember that someone wanted an immediate
		// one so the `finally` below reschedules at 0 instead of dropping it.
		if (inFlight) {
			pendingImmediate = true;
			return;
		}
		inFlight = true;
		try {
			const gv = get(store).gv;
			// `state` is version-gated by mergeState, but room/members are not — and a
			// poll that STARTED before a POST handed us newer ones would otherwise
			// land after it and revert them (switch the game, watch the chip flick
			// back). Same newest-wins problem, solved with a counter instead.
			const epochAtStart = roomEpoch;
			// Bounded on purpose: `inFlight` above is released only in the `finally`,
			// so without a ceiling one stuck poll silently swallows every later
			// schedule(0) — including the reconcile a failed move fires — until the
			// browser gives up on its own. A cut-short poll costs nothing; it re-runs.
			const d = await api(`/api/rooms/${roomId}/poll?since=${cursor}&gv=${gv}`, {
				timeoutMs: POLL_TIMEOUT_MS
			});
			const overtaken = roomEpoch !== epochAtStart;
			cursor = d.cursor || cursor;
			// Strictly: a real event row, or a state version that actually advanced.
			// NEVER diff members/room — `online` flips purely with elapsed time, so
			// that would pin every client at ACTIVE_MS forever and silently double
			// the Odoo load. (The presence heartbeat writes no event row, so it
			// can't self-re-arm.)
			//
			// `d.state.v > gv`, not a bare truthiness test: the contended phase now
			// receives state on EVERY poll, equal versions included, so `d.state`
			// alone would re-arm activity forever — pinning an abandoned thief room
			// at ACTIVE_MS instead of letting it decay to IDLE_MS.
			if ((d.events?.length ?? 0) > 0 || d.state?.v > gv) markActive();
			ingest({
				events: d.events,
				state: d.state,
				room: overtaken ? undefined : d.room,
				members: overtaken ? undefined : d.members
			});
			errorStreak = 0;
		} catch (e) {
			if (TERMINAL_CODES.has(e?.code)) {
				// We are not in this room any more. Without this the client polls
				// forever at full cadence — sustained Odoo load from someone who
				// isn't even here, against a rate limit the whole room shares.
				// `schedule()` early-returns on `stopped`, so the finally is a no-op.
				stopped = true;
				store.update((s) => ({ ...s, error: e.message, closed: true }));
			} else {
				errorStreak++;
				// A poll is a READ. api()'s wording — "that may not have gone
				// through" — is about a write whose effect is unknown, and means
				// nothing here; a poll that failed simply didn't read anything.
				// Anything the server actually said (a 500's message) still wins.
				// Noun phrase on purpose — the banner appends "— retrying…".
				const msg = e?.offline ? 'Connection trouble' : e.message;
				store.update((s) => ({
					...s,
					error: errorStreak > ERROR_QUIET_STREAK ? msg : null
				}));
			}
		} finally {
			inFlight = false;
			const immediate = pendingImmediate;
			pendingImmediate = false;
			// an immediate re-poll must not bypass the error backoff, or a failing
			// room would still hammer whenever a POST had queued one
			schedule(immediate && !errorStreak ? 0 : undefined);
		}
	}

	/** Something genuinely changed — stay responsive for a while. */
	function markActive() {
		lastActivityAt = Date.now();
	}

	function cadence() {
		// FAILING: its own ladder, and it outranks every tier below — including
		// `fast`, despite the "never slow WebRTC" rule there. Two reasons. A tier
		// is an answer to "how likely is something new?", which is the wrong
		// question while nothing is getting through at all; and 1s polling into a
		// failing room is exactly the 429 amplifier a backoff exists to prevent.
		//
		// This used to be a MULTIPLIER on whatever tier applied, which was
		// backwards where it mattered most: one timed-out poll while push was
		// connected gave 60s × 2 = a two-minute frozen board. The socket reporting
		// "connected" says nothing when it plainly isn't delivering, and the poll
		// IS the recovery path — so recovery must not inherit the safety-net
		// interval. 1.5s, 3s, 6s, 12s, then 15s. Coupled to RECONCILE_MS in
		// LudoBoard: the first three attempts fit inside its 6s window, so a
		// pending write usually clears silently. Retune the two together.
		if (errorStreak) return Math.min(ERROR_BASE_MS * 2 ** (errorStreak - 1), ERROR_MAX_MS);
		// Push connected and not negotiating voice: real changes all arrive on the
		// socket, so the timer is ONLY a safety net — back off fully even right
		// after activity. Must outrank the active/base tiers or push saves nothing
		// during play, and outranks `document.hidden` too: backgrounding a healthy
		// room used to take it from 60s to 10s, i.e. hiding the tab made it SIX
		// TIMES noisier against a rate limit the whole room shares.
		// The `!fast` guard is load-bearing — it leaves the hidden-outranks-fast
		// ordering below exactly as it was for the push-off WebRTC path.
		if (pushConnected && !fast) return PUSH_SAFETY_MS;
		if (document.hidden) return HIDDEN_MS;
		if (fast) return FAST_MS; // FAST outranks all — never slow WebRTC
		const quietFor = Date.now() - lastActivityAt;
		if (quietFor < ACTIVE_WINDOW_MS) return ACTIVE_MS;
		if (quietFor < IDLE_AFTER_MS) return BASE_MS;
		return IDLE_MS;
	}

	function schedule(ms) {
		if (stopped) return;
		clearTimeout(timer);
		// re-evaluated every cycle (schedule runs in poll's `finally`), so the tier
		// decays on its own once things go quiet
		const base = ms ?? cadence();
		// jitter de-synchronises the steady state between clients; an explicit
		// "poll now" should not pay ~150ms of it for nothing
		timer = setTimeout(poll, base === 0 ? 0 : base + Math.random() * 300);
	}

	/**
	 * An event arrived that means state moved, but no state came with it.
	 *
	 * `ingest` renders nothing for a `pick` — it notes the id and stops — so a
	 * client that received the event but missed (or correctly dropped) the
	 * matching state push knew something had changed and then sat on the 60s
	 * safety net anyway. This closes that gap.
	 *
	 * Deliberately NOT cancelled when a state push does arrive: in the equal-`v`
	 * collision the push arrives and is *rightly* rejected by mergeState, which is
	 * exactly the case needing the poll. Deliberately not `schedule(0)` either —
	 * five players picking would fire a burst of polls against a rate limit the
	 * whole room shares, so it lands late enough to coalesce and is debounced to
	 * one in flight at a time. `schedule` itself still honours the error backoff.
	 */
	function reconcileSoon() {
		if (stopped || reconcileTimer) return;
		reconcileTimer = setTimeout(() => {
			reconcileTimer = null;
			wake();
		}, EVENT_RECONCILE_MS + Math.random() * 300);
	}

	/**
	 * "Something happened — poll now", but never faster than the error backoff.
	 *
	 * `poll()`'s own `finally` has always honoured the backoff (see the note
	 * there), but every OTHER wake-bell used to call schedule(0) directly and skip
	 * it. That put the worst case exactly where it hurt: a struggling room made
	 * each failed POST queue an immediate extra poll, so the failures amplified
	 * the load that was causing them — against a rate limit the whole room shares.
	 */
	function wake() {
		schedule(errorStreak ? undefined : 0);
	}

	function onVisibility() {
		if (!document.hidden) {
			markActive(); // user is back and looking — be responsive for a bit
			wake();
		}
	}

	/* ---- realtime wake-bell (Ably) ----------------------------------------
	   An Ably message on this room's channel just means "something changed" —
	   we respond with the normal immediate poll, so all secret filtering and
	   merge logic is unchanged. Best-effort: if realtime is disabled (token
	   endpoint 501s) or anything throws, we never init Ably and the tuned
	   polling tiers carry the room as before. The preflight fetch avoids Ably's
	   retry loop (which would re-hit the token endpoint) when it's off. */
	let userChannel = null;
	async function connectRealtime() {
		try {
			const res = await fetch(`/api/realtime/token?room=${roomId}`);
			if (!res.ok) {
				console.warn('[realtime] off — token endpoint returned', res.status, '(staying on polling)');
				return; // disabled, or not a member — stay on polling
			}
			const AblyLib = await import('ably');
			const Realtime = AblyLib.Realtime || AblyLib.default?.Realtime;
			if (!Realtime || stopped) return;
			ably = new Realtime({ authUrl: `/api/realtime/token?room=${roomId}` });

			// public channel: chat + system events for the whole room
			channel = ably.channels.get(`room:${roomId}`);
			channel.subscribe('event', (msg) => {
				markActive();
				ingest({ events: [msg.data] });
				// A `pick` renders nothing by itself — it is only evidence that the
				// state blob moved. Without this the client knew something had
				// changed and still waited out the 60s safety net.
				if (!SELF_CONTAINED_EVENTS.has(msg.data?.type)) reconcileSoon();
			});
			// carroms live striker/aim — ephemeral, no state behind it, so it must
			// NOT markActive/reconcile. Just hand the cursor data to whoever listens.
			channel.subscribe('aim', (msg) => aimHandler?.(msg.data));
			// roster: the room row + member list, which the state push doesn't carry.
			// Before this they refreshed only on the safety poll, so a join approval,
			// a role change or a host handover took up to 8s to show.
			channel.subscribe('roster', (msg) => {
				const d = msg.data;
				if (!d || !(d.ts > lastRosterTs)) return; // an older push lost the race
				lastRosterTs = d.ts;
				roomEpoch++; // a poll already in flight is now stale — see poll()
				markActive();
				ingest({ room: d.room, members: d.members });
			});

			let wasConnected = false;
			ably.connection.on((sc) => {
				pushConnected = ably?.connection.state === 'connected';
				console.log('[realtime]', ably?.connection.state, pushConnected ? '(push ON)' : '');
				if (sc?.reason) console.warn('[realtime] reason:', sc.reason.message);
				if (pushConnected && !userChannel) {
					// clientId == our uid — subscribe our private channel for filtered
					// state + targeted (signal) events.
					const uid = ably.auth.clientId;
					userChannel = ably.channels.get(`room:${roomId}:u:${uid}`);
					userChannel.subscribe('state', (msg) => {
						markActive();
						ingest({ state: msg.data });
					});
					userChannel.subscribe('event', (msg) => {
						markActive();
						ingest({ events: [msg.data] });
					});
				}
				// Catch-up on EVERY transition into connected, not just the first.
				// iOS tears the WebSocket down whenever the page backgrounds or the
				// screen locks, so this is the normal path there, not an edge case —
				// and `since=cursor` is the only way back to what we missed while
				// away. Previously this only ran on first connect, so a returning
				// phone waited for the safety poll; at the new 60s that would be a
				// very visible stall. This is also why `cursor` tracks the last
				// POLL and not the last push (see ingest): it has to mean "the
				// point below which we have everything", not "the highest id
				// anyone ever pushed at us", or the catch-up skips the gap.
				// Deliberately schedule(0) and NOT wake(): a socket that just came up
				// is the one hard piece of evidence the network is healthy again, so
				// the error backoff would be answering a question already settled. It
				// can't run away either — Ably's own reconnect backoff paces it.
				if (pushConnected && !wasConnected) schedule(0);
				wasConnected = pushConnected;
			});
		} catch (e) {
			pushConnected = false;
			console.warn('[realtime] connect failed:', e?.message);
		}
	}

	function open() {
		stopped = false;
		document.addEventListener('visibilitychange', onVisibility);
		connectRealtime();
		poll();
	}

	function close() {
		stopped = true;
		clearTimeout(timer);
		clearTimeout(reconcileTimer);
		reconcileTimer = null;
		document.removeEventListener('visibilitychange', onVisibility);
		try {
			channel?.unsubscribe();
			userChannel?.unsubscribe();
			ably?.close();
		} catch {
			/* ignore teardown errors */
		}
		ably = null;
		channel = null;
		userChannel = null;
		pushConnected = false;
		// leaving the room ends the life of every blob URL we minted for it
		for (const c of get(store).chat) revokeLocal(c);
	}

	/* ---- optimistic chat --------------------------------------------------
	   A message sent by us would otherwise only appear once the poll fetched it
	   back out of Odoo — two round trips away. Insert it right away under a
	   temp id, then swap in the real id so the poll echo dedupes against it. */

	/** Insert a local message immediately; returns its temp id. */
	function pushLocalChat(senderUid, text) {
		const id = `tmp-${++tempSeq}`;
		store.update((s) => ({ ...s, chat: [...s.chat, { id, senderUid, text, pending: true }] }));
		return id;
	}

	/**
	 * Same, for a photo or voice clip. The bubble renders straight off a local
	 * blob URL, so what you just sent is visible before the upload finishes — and
	 * stays on that URL afterwards rather than re-downloading its own upload.
	 * `localUrl` is therefore owned by the store; every path that can drop the
	 * message revokes it (see revokeLocal).
	 */
	function pushLocalMedia(senderUid, { blob, ...fields }) {
		const id = `tmp-${++tempSeq}`;
		const localUrl = blob ? URL.createObjectURL(blob) : null;
		store.update((s) => ({
			...s,
			chat: [...s.chat, { id, senderUid, ...fields, localUrl, pending: true }]
		}));
		return id;
	}

	function revokeLocal(msg) {
		if (msg?.localUrl) URL.revokeObjectURL(msg.localUrl);
	}

	/** Keep the last 200 messages, releasing the blob URLs of the ones evicted. */
	function trimChat(chat) {
		if (chat.length <= 200) return chat;
		for (const c of chat.slice(0, chat.length - 200)) revokeLocal(c);
		return chat.slice(-200);
	}

	/** Swap a temp id for the server id once the POST is acked. If a poll that was
	 *  already in flight beat the POST response and delivered the message first,
	 *  drop our copy instead — renaming onto an existing id would duplicate the
	 *  key and blow up the keyed {#each}. */
	function resolveLocalChat(tempId, realId, patch) {
		store.update((s) => {
			if (realId != null && s.chat.some((c) => c.id === realId)) {
				revokeLocal(s.chat.find((c) => c.id === tempId));
				return { ...s, chat: s.chat.filter((c) => c.id !== tempId) };
			}
			return {
				...s,
				chat: s.chat.map((c) =>
					c.id === tempId ? { ...c, ...patch, id: realId ?? c.id, pending: false } : c
				)
			};
		});
	}

	/** Drop a local message whose POST failed. */
	function dropLocalChat(tempId) {
		store.update((s) => {
			revokeLocal(s.chat.find((c) => c.id === tempId));
			return { ...s, chat: s.chat.filter((c) => c.id !== tempId) };
		});
	}

	// `chat` inserts optimistically, so its echo poll would fetch a message we
	// already have. `signal` keeps its echo on purpose: it's how the sender picks
	// up the peer's reply, and voice negotiation is worth the extra request.
	const NO_ECHO_POLL = new Set(['chat', 'carroms/aim']);

	/**
	 * POST to a room sub-route. If the response carried our new state (and/or a
	 * changed room row) we apply it directly and leave the poll timer alone —
	 * that saves a whole round trip on the acting player's own move, which is the
	 * latency they notice most.
	 *
	 * `room`/`members` matter for the game-type switch: it echoes back rows the
	 * poll would otherwise be the only source of, and since the response also
	 * carries state, no immediate re-poll is scheduled to go and fetch them.
	 */
	async function post(path, body) {
		let d;
		try {
			d = await api(`/api/rooms/${roomId}/${path}`, { method: 'POST', body });
		} catch (e) {
			// The response never arrived, so we can't know whether the server applied
			// this. Resending is NOT safe: writes bump state.v and the poll is served
			// from a 750ms room-snapshot cache, so a reconciling read can miss a write
			// that did land — and a carroms shot re-applied on a retained turn would
			// score twice. Ask the server instead and let the next authoritative state
			// settle it; the board corrects itself either way.
			// wake() asks once, immediately. reconcileSoon() asks again ~1.2s later:
			// the first poll can be served a room snapshot from ANOTHER Lambda
			// container, whose 750ms cache writeState's invalidate cannot reach — so
			// a move that did land shows as nothing and the banner would otherwise
			// sit there until the 60s safety net.
			if (e?.offline) {
				wake();
				reconcileSoon();
			}
			throw e;
		}
		markActive(); // we just did something; others are likely to respond
		if (d?.room || d?.members) roomEpoch++; // ours is newer than any poll in flight
		if (d?.state || d?.room || d?.members) ingest({ state: d.state, room: d.room, members: d.members });
		else if (!NO_ECHO_POLL.has(path)) wake();
		return d;
	}

	/** 1s polling while voice connections are being negotiated. */
	function setFast(v) {
		if (fast === !!v) return;
		fast = !!v;
		schedule();
	}

	return {
		subscribe: store.subscribe,
		open,
		close,
		post,
		onSignal,
		onSystem,
		onAim,
		setFast,
		pushLocalChat,
		pushLocalMedia,
		resolveLocalChat,
		dropLocalChat,
		pollNow: () => wake()
	};
}

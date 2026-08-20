// Room transport: a WebSocket to the room's Durable Object, with one
// consolidated GET as the fallback when that socket is down.
//
// THE TIER LADDER IS GONE, with the Odoo budget that justified it. It existed
// because every poll cost ~3 Odoo calls against a shared ~1 req/s limit, so the
// interval had to be a guess about how likely something was to have changed.
// Nothing is guessed now: the socket delivers the change itself, so the poll has
// exactly two jobs — a safety net while the socket is healthy, and a catch-up
// while it is not. See cadence().
import { writable, get } from 'svelte/store';
import { api, POLL_TIMEOUT_MS } from '$lib/api.js';
import { outranksAtSameVersion } from '$lib/games.js';
import {
	startMetrics, stopMetrics, recordWriteRtt, recordPollRtt,
	recordStateArrival, recordPollError, recordBanner, recordPushConnected
} from '$lib/metrics.js';

// Socket healthy: every actual change — state, events, roster — arrives on the
// wire, so the timer is purely a belt-and-braces re-read.
//
// Five minutes is a decision M2.6 unlocked. This used to be pinned under
// PRESENCE_WINDOW_MS (90s) because presence RODE ON THE POLL: a client that
// stopped polling rendered offline to everyone else. Presence is now a union of
// last_seen and an open socket, and the object refreshes last_seen for every
// connected player once a minute — so a socket client is visibly online whether
// or not it ever polls, and this constant is free of that coupling. It stays a
// real number rather than null because a half-open socket that the pong watchdog
// has not yet caught is still possible, and this is the floor under that.
const IDLE_SAFETY_MS = 300000;
// Socket DOWN: catch-up cadence. Affordable at 2s only because it now reads the
// Durable Object rather than Odoo — that is the whole reason this endpoint
// survived the milestone rather than being deleted with the rest of the polling.
const FALLBACK_MS = 2000;
// Reasons the poll must give up rather than retry. Anything else is transient.
const TERMINAL_CODES = new Set(['removed', 'not_member']);
// Retry ladder while polls are failing — see cadence(). Deliberately NOT a
// multiplier on the interval it replaces: recovery has to be fast, and the
// interval it would have multiplied is the five-minute safety net.
const ERROR_BASE_MS = 1500;
const ERROR_MAX_MS = 15000;
// One failure is a blip that the ladder above heals in ~1.5s. Warning about it
// is worse than staying quiet — the banner is what made a self-healing hiccup
// look like a broken game. Speak up once it's clearly not recovering.
const ERROR_QUIET_STREAK = 1;
// How long to wait after an event that implies state moved before reconciling.
//
// KEPT, but no longer for the reason it was written. The old justification was
// budget — a five-player picking round would fire a burst of polls at a shared
// ~1 req/s Odoo limit. That limit is no longer on this path. What survives is the
// case it actually repairs: two picks landing on the SAME state version with
// different claim maps, where the client holding the emptier one sits at gv == v
// and a strict `>` would never send it anything again. The delay lets the state
// push that normally follows the event land first, so the common case costs
// nothing. Coupled to the debounce in reconcileSoon — one timer at a time.
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
		// Is there older chat on the server? In the STORE, not a module-scope flag
		// with a getter: the "load older" control derives from it, and a plain
		// variable is invisible to reactivity, so the button never retires.
		hasMoreChat: true,
		wins: {}, // cumulative room scoreboard, { uid: games won }
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
	let errorStreak = 0; // consecutive failed polls — drives the backoff below
	let tempSeq = 0;
	let signalHandler = null; // webrtc manager subscribes here
	let systemHandler = null;
	let aimHandler = null; // carroms live striker/aim subscribes here
	let tickHandler = null; // match-3 live score ticker subscribes here
	let moveHandler = null; // Hide & Fire live player transforms subscribe here
	// True while the room's socket is up and proven — set on `welcome`, cleared the
	// moment it drops. Keeps its old name deliberately: it is what cadence() reads
	// and what the Stage 0a beacon measures, and both mean exactly what they always
	// did — "real changes are arriving on a wire, so the timer is only a safety
	// net". Only the wire underneath it changed.
	let pushConnected = false;
	// Bumped whenever a POST response OR a roster frame hands us authoritative
	// room/members. Acts as the version gate those two rows don't otherwise have —
	// see poll().
	let roomEpoch = 0;
	/* ---- persisted read position ------------------------------------------
	   Where this device had read up to, so reopening a room does not ask for the
	   whole retained log again. Only safe now that chat has its own endpoint: while
	   chat arrived solely as a side effect of the cursor-0 replay, starting from a
	   stored position would have left the panel empty.
	   Same `gameroom:<thing>` convention as the board themes, and the same guards —
	   storage throws in private mode and is absent during SSR. */
	const CURSOR_KEY = `gameroom:cursor:${roomId}`;
	function readStoredCursor() {
		if (typeof localStorage === 'undefined') return 0;
		try {
			return Number(localStorage.getItem(CURSOR_KEY)) || 0;
		} catch {
			return 0;
		}
	}
	function storeCursor(v) {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(CURSOR_KEY, String(v));
		} catch {
			/* private mode or quota — the cursor is an optimisation, not state */
		}
	}
	function clearStoredCursor() {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.removeItem(CURSOR_KEY);
		} catch {
			/* as above */
		}
	}

	// Did we start this session from a stored position? If so the first batch is
	// genuinely "what you missed", not the room's history — see ingest.
	let restoredCursor = false;
	let firstBatchDone = false;
	// Rosters carry a server timestamp for the same reason: two pushes can arrive
	// out of order and there is no version field to compare.
	let lastRosterTs = 0;
	let unsubBanner = null; // store subscription feeding the Stage 0 banner timer
	// Whether this room gets a socket at all, from the `do` flag on the room detail
	// response. One flag source feeds both sides, so client and server can never
	// disagree about the transport — and it is the lever every Playwright spec
	// leans on to stay on the HTTP path.
	let usingSocket = false;

	/**
	 * Claim the WebRTC signal channel. Returns a disposer — CALL IT ON UNMOUNT.
	 *
	 * One slot, last writer wins, and for a long time there was no way to give it
	 * back. That is what wedged voice after a video call: VideoCallRoom claimed the
	 * slot, was destroyed without releasing it, and every subsequent offer/answer/ice
	 * was handed to a mesh whose `joined` was already false — which silently buffers
	 * signals into preJoinSignals and drains them only from join(), a call that
	 * never comes again for a mesh whose component is gone. No error, no state
	 * change, just "connecting…" forever.
	 *
	 * The `signalHandler === fn` check is the load-bearing part, not defensiveness:
	 * Svelte destroys the outgoing component and mounts the incoming one in the same
	 * flush with no ordering guarantee, so a late disposer must not wipe a handler
	 * its successor has already installed.
	 */
	function onSignal(fn) {
		signalHandler = fn;
		return () => {
			if (signalHandler === fn) signalHandler = null;
		};
	}
	function onSystem(fn) {
		systemHandler = fn;
	}
	function onAim(fn) {
		aimHandler = fn;
	}
	/** Match-3 live score ticker. Returns a disposer, unlike onAim/onSystem —
	 *  the board mounts and unmounts with the game type, so a stale handler here
	 *  would keep pushing scores into a component that has gone. */
	function onTick(fn) {
		tickHandler = fn;
		return () => {
			if (tickHandler === fn) tickHandler = null;
		};
	}
	/** Hide & Fire live player transforms. Returns a disposer, like onTick — the
	 *  arena mounts and unmounts with the game type, so a stale handler would keep
	 *  pushing peer positions into a component that has gone. */
	function onMove(fn) {
		moveHandler = fn;
		return () => {
			if (moveHandler === fn) moveHandler = null;
		};
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
			// cumulative room scoreboard — survives every rematch, unlike the
			// per-round `score` on the member rows
			wins: state.wins || {},
			game: state.game ? { ...state.game, v: state.v } : null,
			gv: state.v
		};
	}

	// Event ids already applied — one guard shared by the poll and the socket, so
	// an event delivered by both (a poll in flight when a frame lands) isn't
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
	 * The single apply path for BOTH the poll and the socket. Events dedupe by
	 * id; `state` merges version-gated; `room`/`members` update only when present
	 * (the push carries neither — presence still rides the poll).
	 */
	/* More system events than this in one batch is a backfill, not news. The gap
	   flag catches a cursor that fell off the retained log, but a busy room can
	   hand back fifty events without ever tripping it — and fifty banners at the
	   notice queue's dwell is minutes of scrolling text. */
	const NARRATE_MAX = 10;

	function ingest({ events = [], state, room, members, upto, gap = false }, via = 'poll') {
		/* Announce, or merely apply?
		   - hydration: no stored position AND this is the first batch, so what came
		     back is the room's existing history rather than anything that happened
		     while we were gone;
		   - gap: the server could not prove continuity and sent its newest page;
		   - bulk: too much at once to be news, whatever the server thinks.
		   Everything else IS news, including the batch that arrives on a reconnect
		   or on reopening a room from a stored cursor — which is the whole point of
		   persisting it, and what the flag this replaces had to give up. */
		const hydration = !firstBatchDone && !restoredCursor;
		const replay = hydration || gap || events.length > NARRATE_MAX;
		/* Flipped by the first EVENT-BEARING DELIVERY — poll or welcome, both of
		   which carry `upto` — and NOT by "the first batch that happened to contain
		   something". A quiet room's opening poll returns zero events, and gating on
		   that left the next poll still looking like hydration, so the first real
		   thing to happen in the room was swallowed. That is the leave-announce
		   regression, and it has now been introduced twice; the guard is the fix.
		   State and roster frames carry no `upto` and must not flip it. */
		if (upto !== undefined) firstBatchDone = true;
		// ONE rule for advancing the cursor, and it is always a watermark the SERVER
		// computed: "I have filtered and delivered everything at or below this that
		// you are entitled to". The poll passes its `d.cursor`; the socket passes
		// the DO's `upto`.
		//
		// It must never be derived from the ids we happen to have seen. Targeted
		// events (WebRTC signals) are filtered per recipient, so every client's view
		// of the sequence has holes BY DESIGN and cannot tell "filtered out" from
		// "not yet sent". Advancing from a delivered id is what silently lost a
		// chat message under the old two-channel Ably split — the cursor jumped to a
		// private signal's id 200 and `?since=200` skipped the public chat at 199,
		// permanently, with the reconnect catch-up unable to help.
		if (upto > cursor) {
			cursor = upto;
			storeCursor(cursor);
		}
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
					/* STORED ALWAYS, ANNOUNCED ONLY WHEN IT IS NEWS.

					   A bulk handout replays the newest 200 retained events, and
					   announcing those is what put "X ended the game" and "X waved" back
					   on screen every time a room was opened — at the notice queue's
					   dwell that is about twelve minutes of banner. It also re-fired the
					   handler's side effects: host-changed triggers a poll, and
					   game-abandoned re-arms the window that suppresses a genuine
					   member-left.

					   `replay` is decided at the top of ingest. An earlier attempt inferred
					   it from "cursor is still 0", which the leave-announce specs caught:
					   a quiet room legitimately sits at cursor 0, so the FIRST real event
					   in it was swallowed. The rule now keys off whether we RESUMED from a
					   stored position, which is a fact about this client rather than a
					   guess about the room. */
					evs.push(ev);
					if (!replay) systemHandler?.(ev);
				}
			}
			const next = { ...s, chat: trimChat(chat), events: evs.slice(-50), error: null };
			if (room) next.room = room;
			// `members?.length`, NOT `members`: [] is truthy, so a welcome from a DO
			// that has not hydrated yet would REPLACE a good roster with nothing and
			// the room would render as if the host had vanished — until the next
			// poll, which on the push cadence is up to 60s away. An empty roster is
			// never meaningful anyway; a room always has at least its host.
			if (members?.length) next.members = members;
			const merged = mergeState(next, state);
			// Stage 0: which transport actually delivered a version bump. A bump
			// discovered by POLL means the push didn't land and somebody sat out a
			// safety interval — the watcher-side lag, measured without needing the
			// two machines' clocks to agree. Only counts real advances, so the
			// contended phase's equal-version resends don't inflate it.
			if (state && merged.gv > s.gv) recordStateArrival(via);
			return merged;
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
			const t0 = performance.now();
			let serverMs = null;
			const d = await api(`/api/rooms/${roomId}/poll?since=${cursor}&gv=${gv}`, {
				timeoutMs: POLL_TIMEOUT_MS,
				onMeta: (m) => { serverMs = m.serverMs; }
			});
			recordPollRtt(performance.now() - t0, serverMs);
			const overtaken = roomEpoch !== epochAtStart;
			// The cursor now advances in exactly one place — see ingest(). The poll's
			// own watermark is handed over as `upto` rather than assigned here, so
			// both transports go through the same rule.
			//
			// The activity bookkeeping that used to live here went with the tier
			// ladder: there is no longer a cadence for "something changed recently"
			// to feed, so nothing has to be careful about what counts as a change.
			//
			// The HTTP path's `resync`. Our cursor fell below the retained log, so
			// the server sent the newest page instead of the window we asked for and
			// continuity cannot be proven — without this the cursor would jump to the
			// end of that page and the block in between would be silently, permanently
			// missing. Additive on the wire, so a server that never sets it (any room
			// still on the Odoo path) behaves exactly as before.
			//
			// Same treatment as the socket's `resync` frame, deliberately identical:
			// two different repairs for the same condition is how the two transports
			// start disagreeing about what the client holds.
			if (d.gap) {
				appliedEventIds.clear();
				roomEpoch++;
			}
			ingest({
				events: d.events,
				state: d.state,
				room: overtaken ? undefined : d.room,
				members: overtaken ? undefined : d.members,
				upto: d.cursor,
				gap: !!d.gap
			}, 'poll');
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
				recordPollError();
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

	/**
	 * Two states, and that is the whole function.
	 *
	 * The tier ladder is gone with the Odoo budget that justified it; what is left
	 * is "the socket has it" versus "the socket is down, recover". Every tier this
	 * replaces was an estimate of how likely a change was, which is a question
	 * nobody has to ask once the change itself arrives on a wire.
	 *
	 * `document.hidden` went too. It existed because backgrounding used to change
	 * how much we could afford to poll; it now says nothing about whether the
	 * socket is delivering. (onVisibility still matters — it reconnects the socket
	 * iOS tore down — but that is a socket concern, not a cadence one.)
	 */
	function cadence() {
		// FAILING outranks both, and still for the original reason: a tier is an
		// answer to "how likely is something new?", which is the wrong question
		// while nothing is getting through at all. 1.5s, 3s, 6s, 12s, then 15s.
		// Coupled to RECONCILE_MS in LudoBoard — the first three attempts fit inside
		// its 6s window, so a pending write usually clears silently. Retune together.
		if (errorStreak) return Math.min(ERROR_BASE_MS * 2 ** (errorStreak - 1), ERROR_MAX_MS);
		return pushConnected ? IDLE_SAFETY_MS : FALLBACK_MS;
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
			// iOS tears the WebSocket down whenever the page backgrounds or the
			// screen locks. That is the NORMAL path there, not an edge case, so a
			// returning user must reconnect immediately rather than wait out the
			// backoff — the same reasoning as the schedule(0)-not-wake() note below.
			if (usingSocket && !sock && !sockDead) {
				sockBackoff = SOCK_BACKOFF_MIN;
				scheduleReconnect(true);
			}
			wake();
		}
	}

	/* ---- Durable Object socket -------------------------------------------
	   One ordered stream per room, terminated by the room's object. The only push
	   transport there is now — Ably and its two-channel split are gone, and with
	   them the class of bug that came from having no ordering BETWEEN channels.
	   Enabled per room by the `do` flag on the room-detail response. */
	const SOCK_BACKOFF_MIN = 500;
	const SOCK_BACKOFF_MAX = 15000;
	const SOCK_PING_MS = 25000;
	const SOCK_PONG_GRACE_MS = 10000;

	let sock = null;
	let sockBackoff = SOCK_BACKOFF_MIN;
	let sockTimer = null;
	let pingTimer = null;
	let pongTimer = null;
	let sockDead = false; // terminal — stop reconnecting (kicked, or room gone)

	function clearSockTimers() {
		clearTimeout(sockTimer); sockTimer = null;
		clearInterval(pingTimer); pingTimer = null;
		clearTimeout(pongTimer); pongTimer = null;
	}

	function scheduleReconnect(immediate = false) {
		if (stopped || sockDead || sockTimer) return;
		// Full jitter, not just exponential: a room-wide disconnect would otherwise
		// bring every client back in lockstep and hammer the same object.
		const wait = immediate ? 0 : Math.random() * sockBackoff;
		sockBackoff = Math.min(sockBackoff * 2, SOCK_BACKOFF_MAX);
		sockTimer = setTimeout(() => { sockTimer = null; connectSocket(); }, wait);
	}

	function dropSocket() {
		clearSockTimers();
		if (pushConnected) recordPushConnected(false);
		pushConnected = false;
		try { sock?.close(); } catch { /* ignore */ }
		sock = null;
	}

	function connectSocket() {
		if (stopped || sockDead || sock) return;
		let ws;
		try {
			const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
			ws = new WebSocket(`${proto}//${location.host}/api/rooms/${roomId}/ws`);
		} catch (e) {
			console.warn('[socket] construct failed:', e?.message);
			return scheduleReconnect();
		}
		sock = ws;

		ws.onopen = () => {
			// `cursor` is "the point below which I have everything" — the DO replays
			// from it, or answers `resync` when it can no longer prove continuity.
			try { ws.send(JSON.stringify({ t: 'hello', cursor, gv: get(store).gv, v: 1 })); } catch { /* ignore */ }
			clearInterval(pingTimer);
			pingTimer = setInterval(() => {
				if (ws.readyState !== 1) return;
				try { ws.send('p'); } catch { return; }
				// A half-open socket — common on carrier NAT — reports OPEN forever and
				// delivers nothing. The missing pong is the only reliable detection.
				clearTimeout(pongTimer);
				pongTimer = setTimeout(() => { if (sock === ws) { dropSocket(); scheduleReconnect(); } }, SOCK_PONG_GRACE_MS);
			}, SOCK_PING_MS);
		};

		ws.onmessage = (ev) => {
			if (ev.data === 'o') { clearTimeout(pongTimer); pongTimer = null; return; }
			let f;
			try { f = JSON.parse(ev.data); } catch { return; }
			handleFrame(f);
		};

		ws.onerror = () => { /* close always follows; handle it there */ };

		ws.onclose = (e) => {
			if (sock !== ws) return; // superseded
			const wasUp = pushConnected;
			dropSocket();
			if (e.code === 4003) {
				// Membership revoked — terminal, same as the poll's TERMINAL_CODES.
				sockDead = true;
				stopped = true;
				store.update((s) => ({ ...s, error: 'The host removed you from this room', closed: true }));
				return;
			}
			if (e.code === 4002) {
				// The DO handed the room back. Not an error: fall through to HTTP and
				// stop retrying, or we would fight the evacuation.
				//
				// REBUILD, don't resume — the id space changes underneath us. The
				// object minted its own ids (1, 2, 3…); the archive wrote those same
				// messages to Odoo, which assigned its own, far higher ones. So a poll
				// resuming at `since=3` asks Odoo for "everything above 3" and gets the
				// whole history back under different keys — every message we already
				// hold, duplicated. Dropping the cursor and the chat and re-reading is
				// the only coherent answer, and it is the treatment `gap` and `resync`
				// already give the same problem: we cannot prove continuity across the
				// handover, so we do not pretend to.
				sockDead = true;
				console.warn('[socket] evacuated — rebuilding from the HTTP envelope');
				cursor = 0;
				clearStoredCursor();
				appliedEventIds.clear();
				// The rebuild that follows is hydration, not news: the object handed the
				// room back to Odoo and ids are about to be re-derived, so nothing that
				// comes next can be trusted as "what you missed".
				restoredCursor = false;
				firstBatchDone = false;
				roomEpoch++;
				store.update((s) => ({ ...s, chat: [], events: [] }));
				schedule(0);
				return;
			}
			// Everything else is transient. A close BEFORE we ever came up must land
			// here too — on the polling fallback, never on the terminal path and
			// never in a tight loop.
			if (wasUp) schedule(0);
			scheduleReconnect();
		};
	}

	function handleFrame(f) {
		switch (f.t) {
			case 'welcome':
			case 'resync': {
				sockBackoff = SOCK_BACKOFF_MIN; // proven good — reset the ladder
				if (!pushConnected) recordPushConnected(true);
				pushConnected = true;
				if (f.gap) {
					// Our cursor fell below the retained log, so continuity cannot be
					// proven. Rebuild rather than assume — the same treatment the HTTP
					// fallback gets from its `gap` flag.
					appliedEventIds.clear();
					roomEpoch++;
				}
				lastRosterTs = f.ts ?? lastRosterTs;
				/* A welcome carries `gap` when the object could not prove continuity,
				   and the bulk guard in ingest catches the cursor-0 case (the newest
				   200 retained events is far past NARRATE_MAX). Between them, a welcome
				   no longer needs to be silenced wholesale — so a reconnect that hands
				   back the three things you missed now says so. */
				ingest({ events: f.events ?? [], state: f.state, room: f.room, members: f.members, upto: f.upto, gap: !!f.gap }, 'push');
				// Re-arm the poll on the new (much longer) push cadence.
				schedule();
				break;
			}
			case 'state':
				// No `upto` on purpose — a state frame delivers no events, so it may
				// not move the event cursor. See frames.js stateFrame.
				ingest({ state: f.state }, 'push');
				break;
			case 'event':
				ingest({ events: [f.event], upto: f.upto }, 'push');
				if (!SELF_CONTAINED_EVENTS.has(f.event?.type)) reconcileSoon();
				break;
			case 'roster':
				if (!(f.ts > lastRosterTs)) return; // an older frame lost the race
				lastRosterTs = f.ts;
				roomEpoch++;
				ingest({ room: f.room, members: f.members }, 'push');
				break;
			case 'aim':
				// Ephemeral: no state behind it, so deliberately no markActive/reconcile.
				aimHandler?.(f.data);
				break;
			case 'tick':
				// Ephemeral, same as 'aim' — a live score, with no state behind it.
				tickHandler?.(f.data);
				break;
			case 'move':
				// Ephemeral, same as 'aim' — a live Hide & Fire transform, no state.
				moveHandler?.(f.data);
				break;
		}
	}

	function open({ useSocket = false } = {}) {
		stopped = false;
		// Resume where this device left off, so the room does not re-request its
		// whole retained log. `restoredCursor` is what tells ingest the first batch
		// is news rather than history.
		cursor = readStoredCursor();
		restoredCursor = cursor > 0;
		firstBatchDone = false;
		sockDead = false;
		sockBackoff = SOCK_BACKOFF_MIN;
		usingSocket = !!useSocket;
		startMetrics(roomId);
		// Measure the banner from the store rather than from the paths that set it.
		// `error` is cleared inside ingest's update, and a successful-but-EMPTY poll
		// early-returns before reaching it — so transition-tracking at the call
		// sites would drift from what the player is actually looking at.
		unsubBanner = store.subscribe((s) => recordBanner(!!s.error));
		document.addEventListener('visibilitychange', onVisibility);
		// No socket means the poll IS the transport, at FALLBACK_MS. That is the
		// path every Playwright spec takes (none of them set `do`), and the one a
		// room takes if DO_ROOMS ever turns off.
		if (usingSocket) connectSocket();
		poll();
		/* Chat's own first page, in parallel with the poll rather than waiting on it.
		   This is what decouples history from the event log: chat used to appear only
		   because a cursor-0 client was handed the entire retained log, which is the
		   coupling that made the cursor impossible to persist. Best-effort — a failure
		   here costs history, not the room. */
		loadOlderChat().catch(() => {});
	}

	function close() {
		stopped = true;
		unsubBanner?.();
		unsubBanner = null;
		stopMetrics(); // flushes what this session accrued before the refs go
		clearTimeout(timer);
		clearTimeout(reconcileTimer);
		reconcileTimer = null;
		document.removeEventListener('visibilitychange', onVisibility);
		sockDead = true; // stop the reconnect ladder before tearing the socket down
		dropSocket();
		pushConnected = false;
		// leaving the room ends the life of every blob URL we minted for it
		for (const c of get(store).chat) revokeLocal(c);
	}

	/* ---- optimistic chat --------------------------------------------------
	   A message sent by us would otherwise only appear once the poll fetched it
	   back out of Odoo — two round trips away. Insert it right away under a
	   temp id, then swap in the real id so the poll echo dedupes against it. */

	/**
	 * Fetch a page of older chat and prepend it.
	 *
	 * PREPEND, NEVER RE-SORT. Optimistic sends carry string ids (`tmp-N`) and are
	 * always appended at the tail; sorting a mixed array would interleave them into
	 * fetched history and, worse, move a message the user is watching.
	 *
	 * Returns how many arrived, so the caller can tell "nothing more" from "failed".
	 */
	let loadingChat = false;
	async function loadOlderChat(limit = 30) {
		if (loadingChat) return 0;
		loadingChat = true;
		try {
			const oldest = get(store).chat.find((c) => typeof c.id === 'number')?.id ?? 0;
			/* redirectOn401: false — history is a BACKGROUND read, and api()'s default
			   is to treat a 401 as "your session died, go to /login". Letting a
			   scroll-back do that would throw someone out of a room they are sitting
			   in over a fetch they did not ask for. Session liveness is the poll's job;
			   it has the terminal-code handling for it. */
			const d = await api(`/api/rooms/${roomId}/chat?before=${oldest}&limit=${limit}`, {
				redirectOn401: false
			});
			const older = d?.messages ?? [];
			// Room for the page we just fetched, so the trim cannot eat it.
			if (older.length) chatCap = Math.min(CHAT_HARD_CAP, chatCap + older.length);
			store.update((s) => {
				// A page can overlap what the live log already delivered — drop dupes
				// rather than letting a repeated key blow up the keyed {#each}.
				const have = new Set(s.chat.map((c) => c.id));
				const fresh = older.filter((m) => !have.has(m.id));
				return { ...s, hasMoreChat: !!d?.more, chat: fresh.length ? [...fresh, ...s.chat] : s.chat };
			});
			return older.length;
		} finally {
			loadingChat = false;
		}
	}
	/** Insert a local message immediately; returns its temp id.
	 *  The `ts` is this client's clock and is provisional — the server stamps its
	 *  own into the payload and that one replaces this on echo. It exists so the
	 *  bubble doesn't render blank for the second before the round trip lands. */
	function pushLocalChat(senderUid, text) {
		const id = `tmp-${++tempSeq}`;
		store.update((s) => ({
			...s,
			chat: [...s.chat, { id, senderUid, text, ts: Date.now(), pending: true }]
		}));
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
			chat: [...s.chat, { id, senderUid, ...fields, ts: Date.now(), localUrl, pending: true }]
		}));
		return id;
	}

	function revokeLocal(msg) {
		if (msg?.localUrl) URL.revokeObjectURL(msg.localUrl);
	}

	/**
	 * Keep the newest `chatCap` messages, releasing the blob URLs of the evicted.
	 *
	 * THE CAP GROWS WITH FETCHED HISTORY, and that is not a nicety. The trim cuts
	 * from the FRONT, which is exactly where loadOlderChat prepends — a fixed 200
	 * meant "load older" appeared to work and then silently discarded the page it
	 * had just fetched, the moment any new message arrived. The hard ceiling keeps
	 * a long scroll-back from growing the array without bound.
	 */
	const CHAT_BASE_CAP = 200;
	const CHAT_HARD_CAP = 1000;
	let chatCap = CHAT_BASE_CAP;
	function trimChat(chat) {
		if (chat.length <= chatCap) return chat;
		for (const c of chat.slice(0, chat.length - chatCap)) revokeLocal(c);
		return chat.slice(-chatCap);
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
	// already have.
	// match3/tick is ephemeral like carroms/aim — it writes nothing, so following
	// it with a reconcile poll would be ~45 pointless round trips per player per
	// round, on the hottest path either race game has.
	const NO_ECHO_POLL = new Set(['chat', 'carroms/aim', 'match3/tick', 'hidefire/move']);

	/**
	 * `signal` is conditional, which is why it can't just join the set above.
	 *
	 * Its echo poll used to be unconditional and justified as "how the sender picks
	 * up the peer's reply". That was true of the old poll-based signalling and is
	 * not true over the socket: the object fans a signal out to the target the
	 * instant it lands. So while the socket is up the echo bought nothing and cost
	 * a great deal — an offer, an answer and an ICE batch every 300ms, PER PEER,
	 * each dragging a full extra poll behind it, all queued against the same
	 * single-threaded object that is trying to serialize the negotiation itself.
	 *
	 * With the socket down there is no fan-out and the reasoning still holds, so
	 * the echo stays. `pushConnected` is cleared the moment the socket drops, which
	 * makes this fall back on its own during a reconnect.
	 */
	const skipEchoPoll = (path) => NO_ECHO_POLL.has(path) || (path === 'signal' && pushConnected);

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
		const t0 = performance.now();
		try {
			d = await api(`/api/rooms/${roomId}/${path}`, { method: 'POST', body });
			// The acting player's own round trip: Lambda + Odoo + the write, which
			// is precisely the term a DO migration removes. Recorded only on
			// success — a timed-out write measures the timeout, not the server.
			recordWriteRtt(path, performance.now() - t0);
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
		if (d?.room || d?.members) roomEpoch++; // ours is newer than any poll in flight
		// 'echo', NOT the 'poll' default: this is the actor's own write coming back
		// in its POST response. Counting it as poll would put ~half of a 2-player
		// game's version bumps in the "push didn't land" bucket and make that ratio
		// meaningless — the actor's latency is already measured by writeRtt.
		if (d?.state || d?.room || d?.members) {
			ingest({ state: d.state, room: d.room, members: d.members }, 'echo');
		}
		else if (!skipEchoPoll(path)) wake();
		return d;
	}

	return {
		subscribe: store.subscribe,
		open,
		close,
		post,
		onSignal,
		onSystem,
		onAim,
		onTick,
		onMove,
		pushLocalChat,
		pushLocalMedia,
		resolveLocalChat,
		dropLocalChat,
		loadOlderChat,
		pollNow: () => wake()
	};
}

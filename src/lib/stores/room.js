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
import { api } from '$lib/api.js';

// Budget, not preference: Odoo Online rate-limits per IP at roughly 1 req/s, and
// every poll costs 3 Odoo calls shared across the whole room. A 4-player room at
// 2.5s already runs ~5 req/s, so these are the slowest values that still feel
// like a game — pushing ACTIVE down to 800ms earned a hard HTTP 429.
const ACTIVE_MS = 1500; // something changed just now — more probably will
const BASE_MS = 2500; // normal play
const IDLE_MS = 10000; // nothing at all for 30s — empty lobby, abandoned game
const ACTIVE_WINDOW_MS = 5000;
const IDLE_AFTER_MS = 30000;
const FAST_MS = 1000; // while WebRTC signaling is in flight
// Reasons the poll must give up rather than retry. Anything else is transient.
const TERMINAL_CODES = new Set(['removed', 'not_member']);
const MAX_ERROR_BACKOFF = 8; // cap the multiplier so recovery stays reasonable
// Capped by presence, not by load: `online` is a 15s window (room.js) and the
// heartbeat only writes when last_seen is >6s old, so anything past ~10s here
// would render idle players permanently offline.
const HIDDEN_MS = 10000;

export function createRoomStore(roomId) {
	const store = writable({
		room: null,
		members: [],
		chat: [], // {id, senderUid, text}
		events: [], // system events (join/leave/draw results...) for the feed
		voice: [],
		game: null,
		gv: 0,
		error: null,
		closed: false
	});

	let cursor = 0;
	let timer = null;
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

	function onSignal(fn) {
		signalHandler = fn;
	}
	function onSystem(fn) {
		systemHandler = fn;
	}

	/**
	 * Apply a `state` envelope onto a store snapshot, newest-wins.
	 *
	 * Write endpoints echo the caller's state back so an action doesn't cost an
	 * extra round trip — but a poll that STARTED before that POST can land after
	 * it carrying older state. The version gate is what stops the view flicking
	 * backwards; both paths must go through here.
	 */
	function mergeState(s, state) {
		if (!state || state.v <= s.gv) return s;
		return {
			...s,
			voice: state.voice,
			game: state.game ? { ...state.game, v: state.v } : null,
			gv: state.v
		};
	}

	/** Merge a state envelope returned by a POST straight into the store. */
	function applyState(state) {
		if (state) store.update((s) => mergeState(s, state));
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
			const d = await api(`/api/rooms/${roomId}/poll?since=${cursor}&gv=${gv}`);
			cursor = d.cursor || cursor;
			// Strictly: a real event row, or a state version that actually advanced.
			// NEVER diff members/room — `online` flips purely with elapsed time, so
			// that would pin every client at ACTIVE_MS forever and silently double
			// the Odoo load. (The presence heartbeat writes no event row, and
			// d.state only arrives when state.v > gv, so neither can self-re-arm.)
			if ((d.events?.length ?? 0) > 0 || d.state) markActive();
			store.update((s) => {
				const chat = [...s.chat];
				const events = [...s.events];
				// our own messages are inserted optimistically and reconciled to
				// the server id, so the poll echo must not add them a second time
				// ({#each … (msg.id)} throws on duplicate keys)
				const seenChat = new Set(chat.map((c) => c.id));
				for (const ev of d.events || []) {
					if (ev.type === 'chat') {
						if (seenChat.has(ev.id)) continue;
						seenChat.add(ev.id);
						chat.push({ id: ev.id, senderUid: ev.senderUid, text: ev.payload.text });
					} else if (ev.type === 'signal') signalHandler?.(ev.senderUid, ev.payload);
					else if (ev.type === 'system') {
						events.push(ev);
						systemHandler?.(ev);
					}
				}
				const next = {
					...s,
					room: d.room,
					members: d.members,
					chat: chat.slice(-200),
					events: events.slice(-50),
					error: null
				};
				return mergeState(next, d.state);
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
				store.update((s) => ({ ...s, error: e.message }));
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
		// A failing room used to keep hammering at full speed, which is itself a
		// 429 amplifier. Back off while it's broken; reset the moment it recovers.
		const penalty = errorStreak ? Math.min(2 ** errorStreak, MAX_ERROR_BACKOFF) : 1;
		if (document.hidden) return HIDDEN_MS * penalty;
		if (fast) return FAST_MS * penalty; // FAST outranks ACTIVE — never slow WebRTC
		const quietFor = Date.now() - lastActivityAt;
		if (quietFor < ACTIVE_WINDOW_MS) return ACTIVE_MS * penalty;
		if (quietFor < IDLE_AFTER_MS) return BASE_MS * penalty;
		return IDLE_MS * penalty;
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

	function onVisibility() {
		if (!document.hidden) {
			markActive(); // user is back and looking — be responsive for a bit
			schedule(0);
		}
	}

	function open() {
		stopped = false;
		document.addEventListener('visibilitychange', onVisibility);
		poll();
	}

	function close() {
		stopped = true;
		clearTimeout(timer);
		document.removeEventListener('visibilitychange', onVisibility);
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

	/** Swap a temp id for the server id once the POST is acked. If a poll that was
	 *  already in flight beat the POST response and delivered the message first,
	 *  drop our copy instead — renaming onto an existing id would duplicate the
	 *  key and blow up the keyed {#each}. */
	function resolveLocalChat(tempId, realId) {
		store.update((s) => {
			if (realId != null && s.chat.some((c) => c.id === realId)) {
				return { ...s, chat: s.chat.filter((c) => c.id !== tempId) };
			}
			return {
				...s,
				chat: s.chat.map((c) => (c.id === tempId ? { ...c, id: realId ?? c.id, pending: false } : c))
			};
		});
	}

	/** Drop a local message whose POST failed. */
	function dropLocalChat(tempId) {
		store.update((s) => ({ ...s, chat: s.chat.filter((c) => c.id !== tempId) }));
	}

	// `chat` inserts optimistically, so its echo poll would fetch a message we
	// already have. `signal` keeps its echo on purpose: it's how the sender picks
	// up the peer's reply, and voice negotiation is worth the extra request.
	const NO_ECHO_POLL = new Set(['chat']);

	/**
	 * POST to a room sub-route. If the response carried our new state we apply it
	 * directly and leave the poll timer alone — that saves a whole round trip on
	 * the acting player's own move, which is the latency they notice most.
	 */
	async function post(path, body) {
		const d = await api(`/api/rooms/${roomId}/${path}`, { method: 'POST', body });
		markActive(); // we just did something; others are likely to respond
		if (d?.state) applyState(d.state);
		else if (!NO_ECHO_POLL.has(path)) schedule(0);
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
		setFast,
		pushLocalChat,
		resolveLocalChat,
		dropLocalChat,
		pollNow: () => schedule(0)
	};
}

// Room poll loop: one consolidated GET drives chat, presence, voice roster,
// game state and WebRTC signaling. 2s when visible, 10s hidden; an immediate
// extra poll fires after any of our own POSTs so the room feels snappy.
import { writable, get } from 'svelte/store';
import { api } from '$lib/api.js';

const POLL_MS = 2000;
const FAST_MS = 1000; // while WebRTC signaling is in flight
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
	let tempSeq = 0;
	let signalHandler = null; // webrtc manager subscribes here
	let systemHandler = null;

	function onSignal(fn) {
		signalHandler = fn;
	}
	function onSystem(fn) {
		systemHandler = fn;
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
				if (d.state) {
					next.voice = d.state.voice;
					next.game = d.state.game ? { ...d.state.game, v: d.state.v } : null;
					next.gv = d.state.v;
				}
				return next;
			});
		} catch (e) {
			store.update((s) => ({ ...s, error: e.message }));
		} finally {
			inFlight = false;
			const immediate = pendingImmediate;
			pendingImmediate = false;
			schedule(immediate ? 0 : undefined);
		}
	}

	function schedule(ms) {
		if (stopped) return;
		clearTimeout(timer);
		const base = ms ?? (document.hidden ? HIDDEN_MS : fast ? FAST_MS : POLL_MS);
		timer = setTimeout(poll, base + Math.random() * 300);
	}

	function onVisibility() {
		if (!document.hidden) schedule(0);
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

	/** POST to a room sub-route, then poll immediately for the echo. */
	async function post(path, body) {
		const d = await api(`/api/rooms/${roomId}/${path}`, { method: 'POST', body });
		schedule(0);
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

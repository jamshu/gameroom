<script>
	// aliased: `tick` is already taken below by the recording interval handle
	import { tick as nextTick, untrack } from 'svelte';
	import Avatar from './Avatar.svelte';
	import {
		resizeImage,
		base64ToBlob,
		pickAudioMime,
		createVoiceRecorder,
		MAX_VOICE_MS
	} from '$lib/media.js';

	let { store, members, myUid, roomId, borrowMic } = $props();
	let text = $state('');
	let listEl = $state(null);
	let error = $state('');
	let fileInput = $state(null);
	let busy = $state(false); // an attachment is being prepared/uploaded
	let recording = $state(false);
	let elapsed = $state(0); // seconds into the current recording
	let lightbox = $state(null); // {src, alt} while a photo is open full-size
	// Why a given clip wouldn't play, keyed by message id. Deliberately NOT the
	// `error` var above: that one belongs to the send/record paths and a playback
	// failure landing in it would wipe whatever the composer was telling the user.
	let clipErrors = $state({});

	// Hidden entirely where MediaRecorder can't produce anything we accept.
	const canRecord = pickAudioMime() !== null;
	const recorder = canRecord ? createVoiceRecorder({ borrowMic }) : null;
	let tick = null;

	const nameOf = $derived((uid) => members.find((m) => m.uid === Number(uid))?.name || `#${uid}`);

	/* Only the newest PAGE messages are rendered; older ones are revealed a page at
	   a time. The store already holds up to 200 (it trims beyond that), so this is
	   a RENDER window, not a fetch — there is no chat-history endpoint to page
	   against. The win is DOM size: a long room's backlog is mostly images and
	   <audio> elements, and mounting two hundred of them is what made opening the
	   panel feel heavy. */
	const PAGE = 20;
	let shown = $state(PAGE);
	const visible = $derived($store.chat.slice(-shown));
	// Still in the store but not yet on screen.
	const bufferedOlder = $derived(Math.max(0, $store.chat.length - shown));
	// The button shows while there is either something buffered OR more on the
	// server. Without the second half it would vanish at the buffer's edge and
	// the rest of the history would be unreachable.
	const canLoadOlder = $derived(bufferedOlder > 0 || $store.hasMoreChat);

	/* Keep already-revealed history revealed when a new message lands. `shown`
	   counts back from the END, so without this a new arrival would silently push
	   the oldest visible message back out of view while someone is reading it. */
	let prevLen = 0;
	$effect(() => {
		const len = $store.chat.length;
		const grew = len - prevLen;
		prevLen = len;
		// untracked: this effect writes `shown`, and reading it reactively would
		// make it retrigger itself
		if (grew > 0 && untrack(() => shown) > PAGE) shown = untrack(() => shown) + grew;
	});

	// Consecutive messages from the same sender are grouped: only the first of a
	// run carries the avatar + name, so the panel reads as a conversation.
	const rows = $derived(
		visible.map((msg, i) => ({
			msg,
			mine: msg.senderUid === myUid,
			head: i === 0 || visible[i - 1].senderUid !== msg.senderUid
		}))
	);

	/* Autoscroll, but only when the reader is already at the bottom. Following the
	   tail unconditionally yanks the view away from anyone scrolled up reading
	   history the moment someone types. Tracked on scroll rather than measured in
	   the effect below, because by the time that effect runs the new message is
	   already in the DOM and "were we at the bottom?" can no longer be answered. */
	const NEAR_BOTTOM_PX = 120;
	let stickToBottom = true;
	function onScroll() {
		if (!listEl) return;
		stickToBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < NEAR_BOTTOM_PX;
	}

	$effect(() => {
		$store.chat.length;
		if (listEl && stickToBottom) {
			requestAnimationFrame(() => listEl && (listEl.scrollTop = listEl.scrollHeight));
		}
	});

	/**
	 * Another page of history, without the view jumping.
	 *
	 * FETCH-THEN-REVEAL, one pagination rather than two: the window widens through
	 * what is already in the store, and only when it reaches the start of that does
	 * it go to the server for more. `olderCount` below hides the button once both
	 * the buffer and the server are exhausted.
	 */
	let fetching = $state(false);
	async function loadOlder() {
		const el = listEl;
		const beforeHeight = el?.scrollHeight ?? 0;
		const beforeTop = el?.scrollTop ?? 0;
		// Nothing buffered left to reveal — top up from the server first.
		if (bufferedOlder <= 0 && $store.hasMoreChat) {
			fetching = true;
			try {
				await store.loadOlderChat();
			} catch (e) {
				error = e.message;
			} finally {
				fetching = false;
			}
		}
		shown += PAGE;
		await nextTick();
		// Hold the reader's place: everything new was inserted ABOVE them, so shift
		// scrollTop by exactly how much the content grew. Without this the list
		// jumps to the top and they lose their spot.
		if (el) el.scrollTop = beforeTop + (el.scrollHeight - beforeHeight);
	}

	// a recording in flight must not outlive the panel
	$effect(() => () => {
		clearInterval(tick);
		recorder?.cancel();
	});

	/** Where a bubble's bytes come from: our own upload preview, else the room proxy. */
	function srcOf(msg) {
		return msg.localUrl || `/api/rooms/${roomId}/media/${msg.attId}`;
	}

	function mmss(sec) {
		const s = Math.max(0, Math.round(sec));
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	/**
	 * A voice note refused to play. Say why.
	 *
	 * This has to be bound on the element itself — media `error` events don't
	 * bubble and aren't promise rejections, so nothing higher up can ever see
	 * them. Without it the only symptom is a dead-looking player, which is how
	 * the iOS codec problem went unnoticed for so long.
	 *
	 * The element's own MediaError can't tell a 404 from a codec it can't decode
	 * (both surface as SRC_NOT_SUPPORTED, because our JSON error body is also
	 * "not audio"), so re-ask the server with a 1-byte range to get the status.
	 */
	async function clipFailed(msg) {
		let status = 0;
		try {
			const r = await fetch(srcOf(msg), { headers: { Range: 'bytes=0-0' } });
			status = r.status;
		} catch {
			/* offline or blocked — leave status 0 */
		}
		let why;
		if (status === 401 || status === 403) why = "You're no longer a member of this room";
		else if (status === 404) why = 'This voice note is no longer available';
		else if (status === 0) why = "Couldn't reach the server for this voice note";
		else if (status >= 400) why = `Couldn't load this voice note (${status})`;
		else why = `Your browser can't play this recording${msg.mime ? ` (${msg.mime})` : ''}`;
		clipErrors = { ...clipErrors, [msg.id]: why };
	}

	/** It played after all (a retry, or a transient 5xx) — drop the complaint. */
	function clipRecovered(msg) {
		if (!(msg.id in clipErrors)) return;
		const { [msg.id]: _gone, ...rest } = clipErrors;
		clipErrors = rest;
	}

	/** Post one line of text. Returns false if it didn't land, so the composer can
	 *  hand the message back. Shared with the empty-room greeting below. */
	async function postText(t) {
		error = '';
		// show it instantly; the POST + poll round trip happens behind the bubble
		const tempId = store.pushLocalChat(myUid, t);
		try {
			const d = await store.post('chat', { text: t });
			store.resolveLocalChat(tempId, d?.id);
			return true;
		} catch (e2) {
			store.dropLocalChat(tempId);
			error = e2.message;
			return false;
		}
	}

	async function send(e) {
		e.preventDefault();
		const t = text.trim();
		if (!t) return;
		text = '';
		if (!(await postText(t))) text = t; // hand the message back so it isn't lost
	}

	// An empty chat is the hardest one to start, so the placeholder does the
	// typing for you. One tap posts it — same optimistic path as any other line.
	const GREETING = 'Hi 👋';
	let greeting = $state(false);
	async function sayHi() {
		if (greeting || busy) return;
		greeting = true;
		try {
			await postText(GREETING);
		} finally {
			greeting = false;
		}
	}

	/**
	 * Post one attachment. Same optimistic shape as text: the bubble appears off
	 * a local blob URL right away, and `attId` is patched in when the server acks
	 * so a later reader of the same message can fetch it.
	 */
	async function sendMedia({ blob, ...body }) {
		error = '';
		const caption = text.trim();
		text = '';
		const tempId = store.pushLocalMedia(myUid, { ...body, text: caption || undefined, blob });
		try {
			const d = await store.post('chat', { ...body, text: caption || undefined });
			store.resolveLocalChat(tempId, d?.id, { attId: d?.attId });
		} catch (e) {
			store.dropLocalChat(tempId);
			error = e.message;
		}
	}

	async function pickImage(e) {
		const file = e.target.files?.[0];
		e.target.value = ''; // let the same file be picked again later
		if (!file) return;
		busy = true;
		try {
			const { dataBase64, mime, w, h } = await resizeImage(file);
			await sendMedia({
				kind: 'image',
				dataBase64,
				mime,
				w,
				h,
				blob: base64ToBlob(dataBase64, mime)
			});
		} catch (e2) {
			error = e2.message;
		} finally {
			busy = false;
		}
	}

	async function toggleRecord() {
		if (recording) return stopRecord();
		error = '';
		try {
			await recorder.start(stopRecord); // fires on the 60s cap
			recording = true;
			elapsed = 0;
			tick = setInterval(() => (elapsed += 1), 1000);
		} catch {
			error = 'Microphone unavailable — check permissions';
		}
	}

	async function stopRecord() {
		if (!recording) return;
		clearInterval(tick);
		recording = false;
		busy = true;
		try {
			const clip = await recorder.stop();
			if (!clip?.dataBase64) return;
			await sendMedia({
				kind: 'voice',
				dataBase64: clip.dataBase64,
				mime: clip.mime,
				dur: clip.dur,
				blob: clip.blob
			});
		} catch (e) {
			error = e.message;
		} finally {
			busy = false;
			elapsed = 0;
		}
	}

	function cancelRecord() {
		clearInterval(tick);
		recording = false;
		elapsed = 0;
		recorder.cancel();
	}
</script>

<div class="card chat">
	<p class="chat-safety">
		<span class="emo">🔒</span>
		<!-- The auto-delete half of this line is gone because it stopped being true:
		     a room used to vanish when the last member left, taking its chat with it.
		     Rooms now persist until their host deletes them, so promising otherwise
		     here would be a privacy claim the app no longer keeps. -->
		<span>Sent over a secure connection.</span>
	</p>
	<div class="chat-list" bind:this={listEl} onscroll={onScroll}>
		{#if canLoadOlder}
			<button type="button" class="load-older" onclick={loadOlder} disabled={fetching}>
				{#if fetching}
					Loading…
				{:else if bufferedOlder}
					↑ {bufferedOlder} older {bufferedOlder === 1 ? 'message' : 'messages'}
				{:else}
					↑ Older messages
				{/if}
			</button>
		{/if}
		{#each rows as { msg, mine, head } (msg.id)}
			<div
				class="chat-msg {mine ? 'chat-msg--mine' : ''} {head ? 'chat-msg--head' : ''}"
				class:pending={msg.pending}
			>
				{#if head}
					<Avatar
						uid={msg.senderUid}
						name={nameOf(msg.senderUid)}
						size={26}
						ring={mine ? 'accent' : 'dim'}
					/>
				{:else}
					<span class="avatar-spacer"></span>
				{/if}
				<div class="chat-bubble" class:chat-bubble--media={msg.kind}>
					{#if head}
						<span class="chat-who">{mine ? 'You' : nameOf(msg.senderUid)}</span>
					{/if}
					{#if msg.kind === 'image'}
						<button
							class="shot"
							onclick={() =>
								(lightbox = { src: srcOf(msg), alt: `Photo from ${nameOf(msg.senderUid)}` })}
						>
							<img src={srcOf(msg)} alt="Photo from {nameOf(msg.senderUid)}" loading="lazy" />
						</button>
					{:else if msg.kind === 'voice'}
						<span class="clip">
							<!-- svelte-ignore a11y_media_has_caption -->
							<audio
								src={srcOf(msg)}
								controls
								preload="none"
								onerror={() => clipFailed(msg)}
								onloadeddata={() => clipRecovered(msg)}
							></audio>
							{#if msg.dur}<span class="clip-dur">{mmss(msg.dur)}</span>{/if}
						</span>
						{#if clipErrors[msg.id]}
							<span class="clip-err">
								{clipErrors[msg.id]}
								<a href={srcOf(msg)} download>Download</a>
							</span>
						{/if}
					{/if}
					{#if msg.text}<span>{msg.text}</span>{/if}
				</div>
			</div>
		{:else}
			<button type="button" class="say-hi" onclick={sayHi} disabled={greeting || busy}>
				{greeting ? 'Saying hi…' : 'Say hi 👋'}
			</button>
		{/each}
	</div>
	{#if error}<p class="error-text">{error}</p>{/if}
	{#if recording}
		<div class="rec">
			<span class="rec-dot"></span>
			<span>Recording {mmss(elapsed)} / {mmss(MAX_VOICE_MS / 1000)}</span>
			<button type="button" class="btn btn--sm btn--ghost" onclick={cancelRecord}>Cancel</button>
			<button type="button" class="btn btn--sm btn--primary" onclick={stopRecord}>Send</button>
		</div>
	{/if}
	<form class="chat-input" onsubmit={send}>
		<button
			type="button"
			class="btn btn--sm btn--ghost"
			title="Send a photo"
			aria-label="Send a photo"
			disabled={busy || recording}
			onclick={() => fileInput.click()}>📎</button
		>
		{#if canRecord}
			<button
				type="button"
				class="btn btn--sm {recording ? 'btn--danger' : 'btn--ghost'}"
				title="Record a voice message"
				aria-label="Record a voice message"
				disabled={busy}
				onclick={toggleRecord}>🎤</button
			>
		{/if}
		<input type="file" accept="image/*" hidden bind:this={fileInput} onchange={pickImage} />
		<input
			class="input"
			placeholder={busy ? 'Sending…' : 'Message…'}
			bind:value={text}
			maxlength="2000"
		/>
		<button class="btn btn--primary btn--sm" disabled={busy}>Send</button>
	</form>
</div>

{#if lightbox}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="lightbox" onclick={() => (lightbox = null)}>
		<img src={lightbox.src} alt={lightbox.alt} />
	</div>
{/if}

<style>
	.chat {
		display: flex;
		flex-direction: column;
		padding: 12px;
		height: 380px;
	}
	/* stacked (single-column) layout on phones: scale to the viewport instead of a
	   fixed 380px slab that eats half the screen */
	@media (max-width: 760px) {
		.chat {
			height: clamp(260px, 55svh, 420px);
		}
	}
	/* Privacy reassurance — small, calm, sits above the feed. */
	.chat-safety {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0 0 8px;
		padding: 7px 10px;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--green) 12%, var(--surface-2));
		border: 1px solid color-mix(in srgb, var(--green) 35%, var(--border));
		color: var(--text-dim);
		font-size: 0.72rem;
		line-height: 1.35;
	}
	.chat-safety .emo {
		font-size: 0.85rem;
		margin-top: 1px;
	}
	.chat-list {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-bottom: 8px;
		/* the tail is what you care about; keep it pinned when the panel resizes */
		overflow-anchor: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--border) transparent;
	}
	.chat-list::-webkit-scrollbar {
		width: 6px;
	}
	.chat-list::-webkit-scrollbar-thumb {
		background: var(--border);
		border-radius: 999px;
	}
	/* Sticky so it stays reachable while you scroll up through what it revealed,
	   rather than disappearing off the top the moment you use it. */
	.load-older {
		position: sticky;
		top: 0;
		z-index: 1;
		align-self: center;
		margin-bottom: 6px;
		padding: 5px 14px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2, var(--surface));
		color: var(--text-dim);
		font: inherit;
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
		backdrop-filter: blur(6px);
		transition: color 0.15s, border-color 0.15s;
	}
	.load-older:hover,
	.load-older:focus-visible {
		color: var(--text);
		border-color: var(--accent);
	}
	.chat-msg {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}
	/* first message of a run gets breathing room above it */
	.chat-msg--head {
		margin-top: 8px;
	}
	.chat-msg--head:first-child {
		margin-top: 0;
	}
	.chat-msg--mine {
		flex-direction: row-reverse;
	}
	.avatar-spacer {
		width: 26px;
		flex-shrink: 0;
	}
	.chat-bubble {
		background: var(--surface);
		border: 1px solid var(--border);
		/* generous and asymmetric — the squared corner sits beside the avatar, which
		   is the shape every messaging app uses to point a bubble at its sender */
		border-radius: 16px 16px 16px 5px;
		padding: 7px 12px;
		max-width: 85%;
		font-size: 0.9rem;
		line-height: 1.4;
		display: flex;
		flex-direction: column;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
		/* long links and pasted ids must wrap rather than stretch the panel */
		overflow-wrap: anywhere;
		animation: bubble-in 0.16s ease-out;
	}
	.chat-msg--mine .chat-bubble {
		border-radius: 16px 16px 5px 16px;
	}
	/* only the bubble nearest the avatar gets the point; the rest of a run stays
	   fully rounded so a burst reads as one block */
	.chat-msg:not(.chat-msg--head) .chat-bubble {
		border-radius: 16px;
	}
	@keyframes bubble-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.chat-bubble {
			animation: none;
		}
	}
	/* media fills the bubble; the caption below keeps the normal inset */
	.chat-bubble--media {
		padding: 4px;
		gap: 4px;
	}
	.chat-bubble--media .chat-who,
	.chat-bubble--media > span:last-child {
		padding: 0 6px;
	}
	/* A TINT of the accent, not the accent itself. Solid #ff4d6d is the app's
	   loudest colour — right for a primary button you press once, wrong for a
	   column of it running down a chat log, where it fought the text for attention
	   and made every one of your own lines read as an alert. This keeps the bubble
	   unmistakably yours (and on-brand) while letting the words sit on top of it. */
	.chat-msg--mine .chat-bubble {
		background: color-mix(in srgb, var(--accent) 18%, var(--surface-2));
		color: var(--text);
		border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
		align-items: flex-end;
	}
	.chat-who {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-dim);
		letter-spacing: 0.01em;
		margin-bottom: 1px;
	}
	/* --on-accent is a near-black maroon, chosen to sit on the solid accent fill
	   this bubble no longer has. On the tinted background it would be unreadable. */
	.chat-msg--mine .chat-who {
		color: color-mix(in srgb, var(--accent) 55%, var(--text));
	}
	/* Reads as the muted placeholder it replaced until you hover it, so an empty
	   chat still looks calm rather than like it's asking for something. */
	.say-hi {
		align-self: center;
		margin: 16px 0;
		padding: 6px 14px;
		border: 1px solid transparent;
		border-radius: 999px;
		background: none;
		color: var(--text-dim);
		font: inherit;
		cursor: pointer;
	}
	.say-hi:hover:not(:disabled),
	.say-hi:focus-visible {
		border-color: var(--border);
		background: var(--surface);
		color: var(--text);
	}
	.say-hi:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.shot {
		all: unset;
		cursor: zoom-in;
		display: block;
	}
	.shot img {
		display: block;
		max-width: 100%;
		max-height: 200px;
		border-radius: calc(var(--radius) - 2px);
	}
	.clip {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.clip audio {
		height: 32px;
		max-width: 200px;
	}
	.clip-dur {
		font-size: 0.72rem;
		opacity: 0.7;
	}
	.clip-err {
		font-size: 0.72rem;
		color: var(--danger, #e5484d);
		padding: 0 6px 2px;
		display: flex;
		gap: 6px;
		align-items: baseline;
	}
	.clip-err a {
		color: inherit;
	}
	/* in flight — resolves the moment the server acks */
	.pending {
		opacity: 0.55;
	}
	.rec {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
		font-size: 0.82rem;
	}
	.rec-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--danger, #e5484d);
		animation: pulse 1s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.25;
		}
	}
	.chat-input {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
		padding-top: 10px;
		/* a hairline instead of bare space: separates the composer from the feed so
		   the last bubble doesn't read as part of the input row */
		border-top: 1px solid var(--border);
	}
	.chat-input .input {
		flex: 1;
		min-width: 0;
		border-radius: 999px;
	}
	/* round the icon buttons to match the pill composer */
	.chat-input :global(.btn) {
		border-radius: 999px;
	}
	.lightbox {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgba(0, 0, 0, 0.82);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: calc(24px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right))
			calc(24px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
		cursor: zoom-out;
	}
	.lightbox img {
		max-width: 100%;
		max-height: 100%;
		border-radius: var(--radius);
	}
</style>

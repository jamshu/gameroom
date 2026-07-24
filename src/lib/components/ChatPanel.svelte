<script>
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

	// Hidden entirely where MediaRecorder can't produce anything we accept.
	const canRecord = pickAudioMime() !== null;
	const recorder = canRecord ? createVoiceRecorder({ borrowMic }) : null;
	let tick = null;

	const nameOf = $derived((uid) => members.find((m) => m.uid === Number(uid))?.name || `#${uid}`);

	// Consecutive messages from the same sender are grouped: only the first of a
	// run carries the avatar + name, so the panel reads as a conversation.
	const rows = $derived(
		$store.chat.map((msg, i) => ({
			msg,
			mine: msg.senderUid === myUid,
			head: i === 0 || $store.chat[i - 1].senderUid !== msg.senderUid
		}))
	);

	// autoscroll on new messages
	$effect(() => {
		$store.chat.length;
		if (listEl) requestAnimationFrame(() => (listEl.scrollTop = listEl.scrollHeight));
	});

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

	async function send(e) {
		e.preventDefault();
		const t = text.trim();
		if (!t) return;
		error = '';
		text = '';
		// show it instantly; the POST + poll round trip happens behind the bubble
		const tempId = store.pushLocalChat(myUid, t);
		try {
			const d = await store.post('chat', { text: t });
			store.resolveLocalChat(tempId, d?.id);
		} catch (e2) {
			store.dropLocalChat(tempId);
			text = t; // hand the message back so it isn't lost
			error = e2.message;
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
	<div class="chat-list" bind:this={listEl}>
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
							<audio src={srcOf(msg)} controls preload="none"></audio>
							{#if msg.dur}<span class="clip-dur">{mmss(msg.dur)}</span>{/if}
						</span>
					{/if}
					{#if msg.text}<span>{msg.text}</span>{/if}
				</div>
			</div>
		{:else}
			<p class="muted" style="text-align:center; padding:16px 0;">Say hi 👋</p>
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
	.chat-list {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-bottom: 8px;
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
		border-radius: var(--radius);
		padding: 6px 10px;
		max-width: 85%;
		font-size: 0.9rem;
		display: flex;
		flex-direction: column;
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
	.chat-msg--mine .chat-bubble {
		background: var(--accent);
		color: var(--on-accent);
		border-color: transparent;
		align-items: flex-end;
	}
	.chat-who {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-dim);
		letter-spacing: 0.01em;
		margin-bottom: 1px;
	}
	.chat-msg--mine .chat-who {
		color: var(--on-accent);
		opacity: 0.75;
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
		gap: 8px;
		margin-top: 8px;
	}
	.chat-input .input {
		flex: 1;
		min-width: 0;
	}
	.lightbox {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgba(0, 0, 0, 0.82);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		cursor: zoom-out;
	}
	.lightbox img {
		max-width: 100%;
		max-height: 100%;
		border-radius: var(--radius);
	}
</style>

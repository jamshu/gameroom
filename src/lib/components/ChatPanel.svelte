<script>
	import Avatar from './Avatar.svelte';

	let { store, members, myUid } = $props();
	let text = $state('');
	let listEl = $state(null);
	let error = $state('');

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
				<div class="chat-bubble">
					{#if head}
						<span class="chat-who">{mine ? 'You' : nameOf(msg.senderUid)}</span>
					{/if}
					<span>{msg.text}</span>
				</div>
			</div>
		{:else}
			<p class="muted" style="text-align:center; padding:16px 0;">Say hi 👋</p>
		{/each}
	</div>
	{#if error}<p class="error-text">{error}</p>{/if}
	<form class="chat-input" onsubmit={send}>
		<input class="input" placeholder="Message…" bind:value={text} maxlength="2000" />
		<button class="btn btn--primary btn--sm">Send</button>
	</form>
</div>

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
	/* in flight — resolves the moment the server acks */
	.pending {
		opacity: 0.55;
	}
	.chat-input {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
	.chat-input .input {
		flex: 1;
	}
</style>

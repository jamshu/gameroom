<script>
	import Avatar from './Avatar.svelte';

	let { store, members, myUid } = $props();
	let text = $state('');
	let listEl = $state(null);
	let error = $state('');

	const nameOf = $derived((uid) => members.find((m) => m.uid === uid)?.name || `#${uid}`);

	// autoscroll on new messages
	$effect(() => {
		$store.chat.length;
		if (listEl) requestAnimationFrame(() => (listEl.scrollTop = listEl.scrollHeight));
	});

	async function send(e) {
		e.preventDefault();
		const t = text.trim();
		if (!t) return;
		text = '';
		try {
			await store.post('chat', { text: t });
		} catch (e2) {
			error = e2.message;
		}
	}
</script>

<div class="card chat">
	<div class="chat-list" bind:this={listEl}>
		{#each $store.chat as msg (msg.id)}
			<div class="chat-msg {msg.senderUid === myUid ? 'chat-msg--mine' : ''}">
				{#if msg.senderUid !== myUid}
					<Avatar uid={msg.senderUid} name={nameOf(msg.senderUid)} size={22} />
				{/if}
				<div class="chat-bubble">
					{#if msg.senderUid !== myUid}<span class="chat-who">{nameOf(msg.senderUid)}</span>{/if}
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
		gap: 8px;
		padding-bottom: 8px;
	}
	.chat-msg {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}
	.chat-msg--mine {
		justify-content: flex-end;
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
	}
	.chat-who {
		font-size: 0.72rem;
		color: var(--text-dim);
		font-weight: 600;
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

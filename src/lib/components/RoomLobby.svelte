<script>
	import Avatar from './Avatar.svelte';

	let { store, members, room, isHost } = $props();
	let error = $state('');
	let starting = $state(false);

	const accepted = $derived(members.filter((m) => m.status === 'accepted'));
	const pending = $derived(members.filter((m) => m.status === 'pending'));
	const players = $derived(accepted.filter((m) => m.role === 'player'));

	const needed = $derived(
		room.gameType === 'chess' ? 'exactly 2 players' : room.gameType === 'carroms' ? '2 or 4 players' : 'at least 3 players'
	);

	async function handle(memberId, action) {
		error = '';
		try {
			await store.post('requests', { memberId, action });
		} catch (e) {
			error = e.message;
		}
	}

	async function start() {
		error = '';
		starting = true;
		try {
			await store.post('start', {});
		} catch (e) {
			error = e.message;
		} finally {
			starting = false;
		}
	}
</script>

<div class="card" style="padding:20px;">
	<h2 class="section-title" style="margin-top:0;">Lobby</h2>

	{#if isHost && pending.length}
		<h3 class="label">Join requests</h3>
		{#each pending as m (m.id)}
			<div class="member-row">
				<Avatar uid={m.uid} name={m.name} size={30} />
				<span class="member-name">{m.name}</span>
				<span style="flex:1"></span>
				<button class="btn btn--sm btn--primary" onclick={() => handle(m.id, 'accept')}>Accept</button>
				<button class="btn btn--sm btn--ghost" onclick={() => handle(m.id, 'reject')}>Reject</button>
			</div>
		{/each}
		<hr style="border-color:var(--border); margin:14px 0;" />
	{/if}

	<h3 class="label">Members ({accepted.length})</h3>
	{#each accepted as m (m.id)}
		<div class="member-row">
			<Avatar uid={m.uid} name={m.name} size={30} />
			<span class="member-name">{m.name}</span>
			{#if m.uid === room.hostUid}<span class="chip chip--amber">host</span>{/if}
			<span class="chip {m.role === 'player' ? 'chip--green' : ''}">{m.role}</span>
			<span class="dot {m.online ? 'dot--on' : ''}" title={m.online ? 'online' : 'offline'}></span>
		</div>
	{/each}

	{#if error}<p class="error-text">{error}</p>{/if}

	{#if isHost}
		<button class="btn btn--primary" style="margin-top:18px;" onclick={start} disabled={starting}>
			<!-- thief finder has a second, in-game "Start game" button, so this one
			     opens the table rather than claiming to start the game twice -->
			{starting
				? 'Starting…'
				: room.gameType === 'thief_finder'
					? `Open table (${room.drawsTotal} draws)`
					: 'Start'}
		</button>
		<p class="muted" style="margin-top:8px;">Needs {needed}. {players.length} player{players.length === 1 ? '' : 's'} ready.</p>
	{:else}
		<p class="muted" style="margin-top:16px;">Waiting for the host to start…</p>
	{/if}
</div>

<style>
	.member-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
	}
	.member-name {
		font-weight: 500;
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	.dot--on {
		background: var(--green);
	}
</style>

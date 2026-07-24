<script>
	import { untrack } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { GAMES, gameById, seatedPlayerIds } from '$lib/games.js';

	let { store, members, room, isHost } = $props();
	let error = $state('');
	let starting = $state(false);
	let removing = $state(null); // member id being removed
	let promoting = $state(null); // member id being made host
	let switching = $state(false);

	const accepted = $derived(members.filter((m) => m.status === 'accepted'));
	const pending = $derived(members.filter((m) => m.status === 'pending'));
	const players = $derived(accepted.filter((m) => m.role === 'player'));

	const needed = $derived(gameById(room.gameType).needs);

	// What switching to `pick` would do to the seating, worked out client-side
	// from the same capacity rule the server applies — no extra request.
	// untracked seed + an effect that follows: the select is local (you can browse
	// options without switching) but must snap back to the truth when someone else
	// switches, or when our own POST fails.
	let pick = $state(untrack(() => room.gameType));
	let pickDraws = $state(untrack(() => room.drawsTotal) || 5);
	$effect(() => {
		pick = room.gameType;
	});
	const reseat = $derived.by(() => {
		if (pick === room.gameType) return null;
		const seated = seatedPlayerIds(
			accepted.map((m) => ({ id: m.id, accepted: true })),
			pick,
			room.maxPlayers
		);
		return {
			demoted: accepted.filter((m) => m.role === 'player' && !seated.has(m.id)).length,
			promoted: accepted.filter((m) => m.role !== 'player' && seated.has(m.id)).length
		};
	});

	async function switchGame() {
		error = '';
		switching = true;
		try {
			await store.post('game-type', { gameType: pick, drawsTotal: pickDraws });
		} catch (e) {
			error = e.message;
			pick = room.gameType; // the switch didn't happen — don't leave the select lying
		} finally {
			switching = false;
		}
	}

	async function handle(memberId, action) {
		error = '';
		try {
			await store.post('requests', { memberId, action });
		} catch (e) {
			error = e.message;
		}
	}

	async function remove(m) {
		error = '';
		if (!confirm(`Remove ${m.name} from this room?`)) return;
		removing = m.id;
		try {
			await store.post('members', { memberId: m.id, action: 'remove' });
		} catch (e) {
			error = e.message;
		} finally {
			removing = null;
		}
	}

	/** Hand the room over. The host keeps their seat and their place in the game —
	 *  only the room controls move — so this is safe to do at any time. */
	async function makeHost(m) {
		error = '';
		if (!confirm(`Make ${m.name} the host? You'll lose the host controls.`)) return;
		promoting = m.id;
		try {
			await store.post('host', { uid: m.uid });
		} catch (e) {
			error = e.message;
		} finally {
			promoting = null;
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
			{#if isHost && m.uid !== room.hostUid}
				<button
					class="btn btn--ghost btn--sm remove-btn"
					onclick={() => makeHost(m)}
					disabled={promoting === m.id}
					title="Make {m.name} the host of this room"
				>
					{promoting === m.id ? '…' : '👑 Make host'}
				</button>
				<button
					class="btn btn--ghost btn--sm"
					onclick={() => remove(m)}
					disabled={removing === m.id}
					title="Remove {m.name} from this room"
				>
					{removing === m.id ? '…' : 'Remove'}
				</button>
			{/if}
		</div>
	{/each}

	{#if error}<p class="error-text">{error}</p>{/if}

	{#if isHost}
		<!-- Not enough people for Thief Finder, or too many for chess? Change the
		     game here rather than abandoning the room and rebuilding it. Host only —
		     non-hosts already see the game on the header chip. -->
		<hr style="border-color:var(--border); margin:14px 0;" />
		<h3 class="label" style="margin-top:0;">Game</h3>
		<div class="switch-row">
			<select class="select" bind:value={pick} disabled={switching} aria-label="Game">
				{#each GAMES as g (g.id)}
					<option value={g.id}>{g.emoji} {g.label}</option>
				{/each}
			</select>
			{#if pick === 'thief_finder'}
				<select class="select draws" bind:value={pickDraws} disabled={switching} aria-label="Number of draws">
					<option value={5}>5 draws</option>
					<option value={10}>10 draws</option>
				</select>
			{/if}
			{#if pick !== room.gameType}
				<button class="btn btn--sm" onclick={switchGame} disabled={switching}>
					{switching ? 'Switching…' : 'Switch'}
				</button>
			{/if}
		</div>
		{#if reseat && (reseat.demoted || reseat.promoted)}
			<p class="muted" style="margin:8px 2px 0;">
				{#if reseat.demoted}
					{reseat.demoted} player{reseat.demoted === 1 ? '' : 's'} will become spectator{reseat.demoted === 1 ? '' : 's'}.
				{/if}
				{#if reseat.promoted}
					{reseat.promoted} spectator{reseat.promoted === 1 ? '' : 's'} will join as player{reseat.promoted === 1 ? '' : 's'}.
				{/if}
			</p>
		{/if}

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
	.remove-btn {
		margin-left: auto;
	}
	.switch-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.switch-row .select {
		width: auto;
		flex: 1 1 160px;
	}
	.switch-row .draws {
		flex: 0 1 120px;
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

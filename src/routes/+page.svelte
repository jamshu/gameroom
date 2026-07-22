<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/stores/auth.js';
	import { api } from '$lib/api.js';

	const GAME_LABELS = { chess: '♟️ Chess', carroms: '🎯 Carroms', thief_finder: '🕵️ Thief Finder' };

	let myRooms = $state([]);
	let results = $state(null);
	let q = $state('');
	let error = $state('');
	let creating = $state(false);

	// create form
	let showCreate = $state(false);
	let name = $state('');
	let gameType = $state('thief_finder');
	let maxPlayers = $state(8);
	let drawsTotal = $state(5);

	async function loadMine() {
		try {
			const d = await api('/api/rooms/mine');
			myRooms = d.rooms;
		} catch (e) {
			error = e.message;
		}
	}

	async function search(e) {
		e?.preventDefault();
		try {
			const d = await api(`/api/rooms?q=${encodeURIComponent(q)}`);
			results = d.rooms;
		} catch (e2) {
			error = e2.message;
		}
	}

	async function createRoom(e) {
		e.preventDefault();
		creating = true;
		error = '';
		try {
			const d = await api('/api/rooms', {
				method: 'POST',
				body: { name, gameType, maxPlayers, drawsTotal }
			});
			goto(`/room/${d.roomId}`);
		} catch (e2) {
			error = e2.message;
			creating = false;
		}
	}

	async function joinRoom(id) {
		try {
			await api(`/api/rooms/${id}/join`, { method: 'POST' });
			goto(`/room/${id}`);
		} catch (e2) {
			error = e2.message;
		}
	}

	onMount(() => {
		if ($user !== null) loadMine();
	});
</script>

<div class="fade-in">
	<section class="card" style="padding:20px; margin-bottom:20px;">
		<form onsubmit={search} class="search-row">
			<input class="input" type="search" placeholder="Search gamerooms by name…" bind:value={q} />
			<button class="btn btn--primary">Search</button>
			<button type="button" class="btn btn--ghost" onclick={() => (showCreate = !showCreate)}>
				{showCreate ? 'Cancel' : '+ New room'}
			</button>
		</form>

		{#if showCreate}
			<form class="create-form" onsubmit={createRoom}>
				<label class="label" for="rname">Room name</label>
				<input id="rname" class="input" bind:value={name} required maxlength="60" />
				<label class="label" for="rgame">Game</label>
				<select id="rgame" class="select" bind:value={gameType}>
					<option value="thief_finder">🕵️ Thief Finder</option>
					<option value="chess">♟️ Chess</option>
					<option value="carroms">🎯 Carroms</option>
				</select>
				{#if gameType === 'thief_finder'}
					<label class="label" for="rdraws">Number of draws</label>
					<select id="rdraws" class="select" bind:value={drawsTotal}>
						<option value={5}>5 draws</option>
						<option value={10}>10 draws</option>
					</select>
					<label class="label" for="rmax">Max players</label>
					<input id="rmax" class="input" type="number" min="3" max="12" bind:value={maxPlayers} />
				{/if}
				<button class="btn btn--primary" style="margin-top:14px;" disabled={creating}>
					{creating ? 'Creating…' : 'Create room'}
				</button>
			</form>
		{/if}
	</section>

	{#if error}<p class="error-text">{error}</p>{/if}

	{#if results}
		<h2 class="section-title">Search results</h2>
		{#if results.length === 0}<p class="muted">No rooms match “{q}”.</p>{/if}
		{#each results as r (r.id)}
			<div class="card card--interactive room-row">
				<div>
					<strong>{r.name}</strong>
					<span class="chip chip--accent">{GAME_LABELS[r.gameType]}</span>
					<span class="muted">host: {r.hostName} · {r.status}</span>
				</div>
				<button class="btn btn--sm btn--primary" onclick={() => joinRoom(r.id)}>Join</button>
			</div>
		{/each}
	{/if}

	<h2 class="section-title">My rooms</h2>
	{#if myRooms.length === 0}
		<p class="muted">You're not in any rooms yet — search for one or create your own.</p>
	{/if}
	{#each myRooms as r (r.id)}
		<a class="card card--interactive room-row" href={`/room/${r.id}`}>
			<div>
				<strong>{r.name}</strong>
				<span class="chip chip--accent">{GAME_LABELS[r.gameType]}</span>
				<span class="muted">host: {r.hostName} · {r.status}</span>
				{#if r.myStatus === 'pending'}<span class="chip chip--amber">awaiting approval</span>{/if}
			</div>
		</a>
	{/each}
</div>

<style>
	.search-row {
		display: flex;
		gap: 10px;
	}
	.search-row .input {
		flex: 1;
	}
	.create-form {
		margin-top: 18px;
		border-top: 1px solid var(--border);
		padding-top: 14px;
	}
	.room-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 18px;
		margin-bottom: 10px;
		text-decoration: none;
		color: var(--text);
	}
	.room-row .chip {
		margin: 0 8px;
	}
</style>

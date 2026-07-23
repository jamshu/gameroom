<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { profile } from '$lib/stores/profile.js';
	import { api } from '$lib/api.js';

	const GAME_LABELS = { chess: '♟️ Chess', carroms: '🎯 Carroms', thief_finder: '🕵️ Thief Finder' };

	/** Focus the node on mount — fires each time the create form opens. */
	function autofocus(node) {
		node.focus();
	}

	let myRooms = $state([]);
	let q = $state('');
	let typeFilter = $state('');
	let statusFilter = $state('');
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

	/* ---- browse ------------------------------------------------------------
	   Odoo Online rate-limits per IP and the whole app shares that budget, so
	   search-as-you-type must NOT be one request per keystroke. We cache a page
	   of recent rooms on load and filter it in memory; the server is only asked
	   when the local set can't answer (the room is older than the cached page).
	*/
	const PAGE = 30; // cached for local filtering
	const SHOWN = 10; // rendered before "Show more"

	let cached = $state([]); // the last server page
	let serverHits = $state(null); // set only when we fall back to the server
	let showAll = $state(false);
	let searching = $state(false);
	let debounce = null;
	let seq = 0; // guards against out-of-order responses

	const filterLocal = (rooms) => {
		const needle = q.trim().toLowerCase();
		return rooms.filter(
			(r) =>
				(!needle ||
					r.name?.toLowerCase().includes(needle) ||
					r.hostName?.toLowerCase().includes(needle)) &&
				(!typeFilter || r.gameType === typeFilter) &&
				(!statusFilter || r.status === statusFilter)
		);
	};

	// server hits are already filtered; local ones still need it applied
	const visible = $derived(serverHits ? serverHits : filterLocal(cached));
	const shown = $derived(showAll ? visible : visible.slice(0, SHOWN));

	async function loadRooms(params = '') {
		const mine = ++seq;
		try {
			const d = await api(`/api/rooms?limit=${PAGE}${params}`);
			if (mine !== seq) return null; // a newer request already answered
			return d.rooms;
		} catch (e2) {
			if (mine === seq) error = e2.message;
			return null;
		}
	}

	/** Only called when in-memory filtering came up empty. */
	async function serverSearch() {
		searching = true;
		const params =
			`&q=${encodeURIComponent(q.trim())}` +
			(typeFilter ? `&type=${typeFilter}` : '') +
			(statusFilter ? `&status=${statusFilter}` : '');
		const rooms = await loadRooms(params);
		if (rooms) serverHits = rooms;
		searching = false;
	}

	/** Typing filters locally for free; the server is a last resort. */
	function onQueryInput() {
		serverHits = null; // back to the local view
		showAll = false;
		clearTimeout(debounce);
		const needle = q.trim();
		if (needle.length < 2) return;
		if (filterLocal(cached).length > 0) return; // local set answered it
		debounce = setTimeout(serverSearch, 400);
	}

	async function search(e) {
		e?.preventDefault();
		clearTimeout(debounce);
		if (!q.trim()) {
			serverHits = null;
			return;
		}
		await serverSearch();
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

	// set when a room ejected us (removed by the host, or the room is gone)
	let notice = $state('');

	onMount(async () => {
		if ($profile) loadMine();
		// one call; everything typed after this filters against it in memory
		const rooms = await loadRooms();
		if (rooms) cached = rooms;
		const left = new URLSearchParams(location.search).get('left');
		if (left) {
			notice = left;
			history.replaceState(null, '', location.pathname); // don't survive a refresh
		}
	});
</script>

<div class="fade-in">
	<section class="card" style="padding:20px; margin-bottom:20px;">
		<form onsubmit={search} class="search-row">
			<input
				class="input"
				type="search"
				placeholder="Search gamerooms by name or host…"
				bind:value={q}
				oninput={onQueryInput}
			/>
			<button class="btn btn--primary" disabled={searching}>{searching ? '…' : 'Search'}</button>
			<button type="button" class="btn btn--ghost" onclick={() => (showCreate = !showCreate)}>
				{showCreate ? 'Cancel' : '+ New room'}
			</button>
		</form>

		<div class="filter-row">
			<select class="select" bind:value={typeFilter} onchange={() => (serverHits = null)}>
				<option value="">All games</option>
				<option value="thief_finder">🕵️ Thief Finder</option>
				<option value="chess">♟️ Chess</option>
				<option value="carroms">🎯 Carroms</option>
			</select>
			<select class="select" bind:value={statusFilter} onchange={() => (serverHits = null)}>
				<option value="">Any status</option>
				<option value="lobby">Open lobby</option>
				<option value="playing">In progress</option>
			</select>
			{#if q || typeFilter || statusFilter}
				<button
					type="button"
					class="btn btn--ghost btn--sm"
					onclick={() => {
						q = '';
						typeFilter = '';
						statusFilter = '';
						serverHits = null;
						showAll = false;
					}}>Clear</button
				>
			{/if}
		</div>

	</section>

	{#if showCreate}
		<section class="card" style="padding:20px; margin-bottom:20px;">
			<h2 class="section-title" style="margin-top:0;">+ New room</h2>
			<form class="create-form" onsubmit={createRoom}>
				<label class="label" for="rname">Room name</label>
				<input id="rname" class="input" bind:value={name} required maxlength="60" use:autofocus />
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
		</section>
	{/if}

	{#if notice}<p class="chip chip--amber notice">{notice}</p>{/if}
	{#if error}<p class="error-text">{error}</p>{/if}

	<h2 class="section-title">
		{q || typeFilter || statusFilter ? 'Matching gamerooms' : 'Latest gamerooms'}
	</h2>
	{#if visible.length === 0}
		<p class="muted">
			{#if searching}Searching…
			{:else if q || typeFilter || statusFilter}No rooms match that — try a different search.
			{:else}No open rooms yet — create the first one.{/if}
		</p>
	{/if}
	{#each shown as r (r.id)}
		<div class="card card--interactive room-row">
			<div>
				<strong>{r.name}</strong>
				<span class="chip chip--accent">{GAME_LABELS[r.gameType]}</span>
				<span class="muted">host: {r.hostName} · {r.status}</span>
			</div>
			<button class="btn btn--sm btn--primary" onclick={() => joinRoom(r.id)}>Join</button>
		</div>
	{/each}
	{#if !showAll && visible.length > SHOWN}
		<button class="btn btn--ghost show-more" onclick={() => (showAll = true)}>
			Show {visible.length - SHOWN} more
		</button>
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
	.notice {
		display: inline-block;
		margin-bottom: 14px;
	}
	.search-row {
		display: flex;
		gap: 10px;
	}
	.search-row .input {
		flex: 1;
	}
	.filter-row {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-top: 10px;
		flex-wrap: wrap;
	}
	.show-more {
		width: 100%;
		margin-bottom: 10px;
	}
	.create-form {
		margin-top: 4px;
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

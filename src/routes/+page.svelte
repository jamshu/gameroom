<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/stores/auth.js';
	import { api } from '$lib/api.js';
	import { GAMES, gameLabel, gameById } from '$lib/games.js';
	import UserPicker from '$lib/components/UserPicker.svelte';

	/** Focus the node on mount — fires each time the create form opens. */
	function autofocus(node) {
		node.focus();
	}

	let myRooms = $state([]);
	let q = $state('');
	let error = $state('');
	let creating = $state(false);

	// create form
	let showCreate = $state(false);
	let name = $state('');
	let gameType = $state('thief_finder');
	let maxPlayers = $state(8);
	let drawsTotal = $state(5);
	// private rooms: only the people on this list see the room at all, and they
	// walk straight in rather than waiting for approval
	let isPrivate = $state(false);
	let guests = $state([]); // [{ uid, name }]

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
		if (!needle) return rooms;
		return rooms.filter(
			(r) =>
				r.name?.toLowerCase().includes(needle) || r.hostName?.toLowerCase().includes(needle)
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
		const params = `&q=${encodeURIComponent(q.trim())}`;
		const rooms = await loadRooms(params);
		if (rooms) serverHits = rooms;
		searching = false;
	}

	let refreshing = $state(false);

	/** Re-pull the recent-rooms page so a room created on another device (or by
	 *  someone else just now) shows up without having to search for it. Drops any
	 *  active search so the fresh list is what's on screen. */
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		error = '';
		serverHits = null;
		showAll = false;
		try {
			const [rooms] = await Promise.all([loadRooms(), $user !== null ? loadMine() : null]);
			if (rooms) cached = rooms;
		} finally {
			refreshing = false;
		}
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
				body: {
					name, gameType, maxPlayers, drawsTotal,
					visibility: isPrivate ? 'private' : 'public',
					// the server adds us to our own list; sending it would be harmless
					allowedUids: isPrivate ? guests.map((u) => u.uid) : []
				}
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
		if ($user !== null) loadMine();
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

<div class="fade-in home">
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
			<button
				type="button"
				class="btn btn--ghost"
				onclick={refresh}
				disabled={refreshing}
				title="Refresh the room list"
				aria-label="Refresh the room list"
			>
				{refreshing ? '…' : '↻'}
			</button>
			<button type="button" class="btn btn--ghost" onclick={() => (showCreate = !showCreate)}>
				{showCreate ? 'Cancel' : '+ New room'}
			</button>
		</form>

	</section>

	<!-- Solo play. Local-only and offline-capable, so it is the one thing on this
	     page that always works — no room to create, nobody to wait for. -->
	<section class="card solo-card">
		<h2 class="section-title" style="margin-top:0;">Play solo</h2>
		<p class="muted" style="margin:0 0 10px;">No room, no waiting — just you.</p>
		<div class="game-tiles">
			<a class="game-tile" href="/solo/sudoku">
				<span class="game-tile-emoji emo">🔢</span>
				<span class="game-tile-label">Sudoku</span>
			</a>
			<a class="game-tile" href="/solo/match3">
				<span class="game-tile-emoji emo">🍬</span>
				<span class="game-tile-label">Candy Survival</span>
			</a>
			<a class="game-tile" href="/solo/chess">
				<span class="game-tile-emoji emo">♟️</span>
				<span class="game-tile-label">Chess</span>
			</a>
			<a class="game-tile" href="/solo/blackjack">
				<span class="game-tile-emoji emo">🎰</span>
				<span class="game-tile-label">Blackjack</span>
			</a>
		</div>
	</section>

	{#if showCreate}
		<section class="card" style="padding:20px; margin-bottom:20px;">
			<h2 class="section-title" style="margin-top:0;">+ New room</h2>
			<form class="create-form" onsubmit={createRoom}>
				<label class="label" for="rname">Room name</label>
				<input id="rname" class="input" bind:value={name} required maxlength="60" use:autofocus />
				<span class="label">Game</span>
				<div class="game-tiles" role="radiogroup" aria-label="Game">
					{#each GAMES as g (g.id)}
						<button
							type="button"
							class="game-tile"
							class:game-tile--on={gameType === g.id}
							role="radio"
							aria-checked={gameType === g.id}
							onclick={() => (gameType = g.id)}
						>
							<span class="game-tile-emoji emo">{g.emoji}</span>
							<span class="game-tile-label">{g.label}</span>
						</button>
					{/each}
				</div>
				{#if gameType === 'thief_finder'}
					<label class="label" for="rdraws">Number of draws</label>
					<select id="rdraws" class="select" bind:value={drawsTotal}>
						<option value={5}>5 draws</option>
						<option value={10}>10 draws</option>
					</select>
					<label class="label" for="rmax">Max players</label>
					<input id="rmax" class="input" type="number" min="3" max="12" bind:value={maxPlayers} />
				{/if}

				<label class="private-toggle">
					<input type="checkbox" bind:checked={isPrivate} />
					<span>🔒 Private room</span>
				</label>
				{#if isPrivate}
					<p class="muted" style="margin:0 2px 6px;">
						Only the people you add here will see this room, and they join without
						waiting for your approval.
					</p>
					<UserPicker
						selected={guests}
						onpick={(u) => (guests = [...guests, u])}
						onremove={(u) => (guests = guests.filter((g) => g.uid !== u.uid))}
					/>
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
		{q ? 'Matching gamerooms' : 'Latest gamerooms'}
	</h2>
	{#if visible.length === 0}
		<p class="muted">
			{#if searching}Searching…
			{:else if q}No rooms match that — try a different search.
			{:else}No open rooms yet — create the first one.{/if}
		</p>
	{/if}
	{#each shown as r (r.id)}
		<div class="card card--interactive room-row">
			<span class="game-badge emo" aria-hidden="true">{gameById(r.gameType).emoji}</span>
			<div class="room-meta">
				<strong>{r.name}</strong>
				<span class="chip chip--accent">{gameLabel(r.gameType)}</span>
				{#if r.visibility === 'private'}<span class="chip" title="Invite only">🔒 private</span>{/if}
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
			<span class="game-badge emo" aria-hidden="true">{gameById(r.gameType).emoji}</span>
			<div class="room-meta">
				<strong>{r.name}</strong>
				<span class="chip chip--accent">{gameLabel(r.gameType)}</span>
				{#if r.visibility === 'private'}<span class="chip" title="Invite only">🔒 private</span>{/if}
				<span class="muted">host: {r.hostName} · {r.status}</span>
				{#if r.myStatus === 'pending'}<span class="chip chip--amber">awaiting approval</span>{/if}
			</div>
		</a>
	{/each}

	<div class="spacer" aria-hidden="true"></div>
	<footer class="credit">
		<p class="credit-line">Created and maintained by <span class="credit-name">Jamshid.K</span></p>
		<p class="credit-sub">
			For any support contact <a href="mailto:jamshu.mkd@gmail.com">jamshu.mkd@gmail.com</a>
		</p>
	</footer>
</div>

<style>
	.notice {
		display: inline-block;
		margin-bottom: 14px;
	}
	.search-row {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.search-row .input {
		flex: 1;
		min-width: 0;
	}
	/* On phones the input takes the whole first row so it isn't squeezed to a
	   sliver next to the buttons, which wrap onto the line below. */
	@media (max-width: 560px) {
		.search-row .input {
			flex-basis: 100%;
		}
		.search-row .btn {
			flex: 1;
		}
	}
	.show-more {
		width: 100%;
		margin-bottom: 10px;
	}
	.create-form {
		margin-top: 4px;
	}
	.private-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 14px 2px 6px;
		cursor: pointer;
		font-weight: 500;
	}
	.room-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 14px 18px;
		margin-bottom: 12px;
		text-decoration: none;
		color: var(--text);
	}
	.room-meta {
		flex: 1;
		min-width: 0;
	}
	.room-row .chip {
		margin: 0 8px;
	}
	/* Big game emoji in a rounded tile — makes each room read at a glance. */
	.game-badge {
		flex-shrink: 0;
		width: 52px;
		height: 52px;
		display: grid;
		place-items: center;
		font-size: 1.7rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
		border: 2px solid var(--border);
	}

	/* Visual game picker — chunky selectable tiles instead of a dropdown. */
	.game-tiles {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 10px;
		margin: 2px 0 4px;
	}
	.game-tile {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border-radius: var(--radius-sm);
		border: 2px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
		font-family: var(--font-display);
		font-size: 0.95rem;
		font-weight: 600;
		transition:
			transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1),
			border-color 0.15s ease,
			background 0.15s ease;
	}
	.game-tile:hover {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
	}
	.game-tile--on {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 16%, var(--surface-2));
		transform: translateY(-2px);
	}
	.game-tile-emoji {
		font-size: 1.6rem;
	}
	.solo-card {
		padding: 20px;
		margin-bottom: 20px;
	}
	/* The solo tiles reuse .game-tile chrome but are links, not radio buttons —
	   they navigate instead of selecting, so there is no --on state. */
	a.game-tile {
		text-decoration: none;
		cursor: pointer;
	}
	@media (max-width: 420px) {
		.game-tiles {
			grid-template-columns: 1fr;
		}
	}

	/* Column layout + a growing spacer keep the credit pinned to the bottom of
	   the viewport on a near-empty page, without detaching it from the flow when
	   the room lists are long. */
	.home {
		display: flex;
		flex-direction: column;
		flex: 1;
	}
	.spacer {
		flex: 1 1 auto;
	}

	/* Sign-off at the foot of the page — hairline ornament above it so it reads
	   as a closing mark rather than another list item. */
	.credit {
		margin: 40px 0 0;
		padding-top: 22px;
		border-top: 1px solid var(--border);
		text-align: center;
	}
	.credit::before {
		content: '';
		display: block;
		width: 40px;
		height: 4px;
		margin: 0 auto 12px;
		border-radius: 999px;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
	}
	.credit-line {
		margin: 0;
		font-family: var(--font-display);
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-dim);
		letter-spacing: 0.01em;
	}
	.credit-name {
		color: var(--text);
		font-weight: 700;
	}
	.credit-sub {
		margin: 4px 0 0;
		font-size: 0.64rem;
		color: var(--text-faint);
	}
	.credit-sub a {
		color: var(--accent);
		text-decoration: none;
		border-bottom: 1px solid transparent;
	}
	.credit-sub a:hover {
		border-bottom-color: currentColor;
	}
</style>

<script>
	import Avatar from './Avatar.svelte';
	import { api } from '$lib/api.js';

	/**
	 * Type-ahead over /api/users/search, used by the create form and by the lobby's
	 * guest list. Both need the same debounce and the same out-of-order guard, so
	 * the search lives here once rather than twice.
	 *
	 * `selected` is [{ uid, name }] and is only rendered when `showChips` — the
	 * lobby draws its own richer list of who's invited, so it opts out.
	 */
	let {
		selected = [],
		onpick,
		onremove = null,
		showChips = true,
		placeholder = 'Search people by name…',
		disabled = false
	} = $props();

	const MIN_CHARS = 2; // matches the server; below this it answers with []
	const DEBOUNCE_MS = 400; // Odoo Online rate-limits per IP, shared app-wide

	let q = $state('');
	let results = $state([]);
	let searching = $state(false);
	let error = $state('');
	let timer = null;
	let seq = 0; // a slow early response must not clobber a newer one

	const chosen = $derived(new Set(selected.map((u) => u.uid)));

	async function run() {
		const mine = ++seq;
		searching = true;
		try {
			const d = await api(`/api/users/search?q=${encodeURIComponent(q.trim())}`);
			if (mine !== seq) return; // a newer request already answered
			results = d.users;
		} catch (e) {
			if (mine === seq) error = e.message;
		} finally {
			if (mine === seq) searching = false;
		}
	}

	function onInput() {
		error = '';
		clearTimeout(timer);
		if (q.trim().length < MIN_CHARS) {
			seq++; // cancel anything in flight, so it can't land on an emptied box
			results = [];
			searching = false;
			return;
		}
		timer = setTimeout(run, DEBOUNCE_MS);
	}

	function pick(u) {
		onpick?.(u);
		// clear the box: picking is the end of one search, and leaving the list up
		// invites a double-add on a slow connection
		q = '';
		results = [];
		seq++;
	}
</script>

<div class="picker">
	<input
		class="input"
		type="search"
		{placeholder}
		{disabled}
		bind:value={q}
		oninput={onInput}
		aria-label="Search people by name"
	/>

	{#if searching}
		<p class="muted picker-hint">Searching…</p>
	{:else if q.trim().length >= MIN_CHARS && results.length === 0}
		<p class="muted picker-hint">Nobody by that name.</p>
	{/if}
	{#if error}<p class="error-text">{error}</p>{/if}

	{#each results as u (u.uid)}
		<button type="button" class="result" onclick={() => pick(u)} disabled={chosen.has(u.uid)}>
			<Avatar uid={u.uid} name={u.name} size={26} />
			<span>{u.name}</span>
			{#if chosen.has(u.uid)}<span class="muted">already added</span>{/if}
		</button>
	{/each}

	{#if showChips && selected.length}
		<div class="chips">
			{#each selected as u (u.uid)}
				<span class="chip chip--accent picked">
					{u.name}
					{#if onremove}
						<button type="button" class="x" onclick={() => onremove(u)} aria-label="Remove {u.name}">
							×
						</button>
					{/if}
				</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.picker-hint {
		margin: 0 2px;
		font-size: 0.85rem;
	}
	.result {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.result:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.result:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 2px;
	}
	.picked {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.x {
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		line-height: 1;
		cursor: pointer;
		padding: 0;
	}
</style>

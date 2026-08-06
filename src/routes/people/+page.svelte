<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api.js';
	import Avatar from '$lib/components/Avatar.svelte';
	import { following, followingPeople, follow } from '$lib/stores/follow.js';

	const MIN_CHARS = 2; // matches the server; below this it answers with []
	const DEBOUNCE_MS = 400; // Odoo Online rate-limits per IP, shared app-wide

	let q = $state('');
	let results = $state([]);
	let searching = $state(false);
	let error = $state('');
	let timer = null;
	let seq = 0; // a slow early response must not clobber a newer one

	onMount(() => follow.load());

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

	// One tap: create a video-call room, seat both, ring them, then walk in.
	let calling = $state(0); // uid being called, 0 when idle
	async function callUser(uid) {
		if (calling) return;
		calling = uid;
		error = '';
		try {
			const d = await api('/api/rooms/call', { method: 'POST', body: { toUid: uid } });
			goto(`/room/${d.roomId}`);
		} catch (e) {
			error = e.message;
			calling = 0;
		}
	}
</script>

<div class="fade-in" style="max-width:440px; margin:0 auto;">
	<h1 class="section-title">Find people</h1>

	<div class="card" style="padding:24px;">
		<input
			class="input"
			type="search"
			placeholder="Search people by name…"
			bind:value={q}
			oninput={onInput}
			aria-label="Search people by name"
		/>

		{#if searching}
			<p class="muted hint">Searching…</p>
		{:else if q.trim().length >= MIN_CHARS && results.length === 0}
			<p class="muted hint">Nobody by that name.</p>
		{/if}
		{#if error}<p class="error-text">{error}</p>{/if}

		{#each results as u (u.uid)}
			<div class="person">
				<Avatar uid={u.uid} name={u.name} size={30} />
				<span class="person-name">{u.name}</span>
				<button
					class="btn btn--ghost btn--sm"
					disabled={calling === u.uid}
					onclick={() => callUser(u.uid)}
					title="Video call {u.name}"
				>
					{calling === u.uid ? '📲 Calling…' : '📹 Call'}
				</button>
				<button
					class="btn btn--ghost btn--sm"
					onclick={() => follow.toggle(u.uid, u.name)}
					title={$following.has(u.uid) ? `Unfollow ${u.name}` : `Follow ${u.name}`}
				>
					{$following.has(u.uid) ? '✓ Following' : '+ Follow'}
				</button>
			</div>
		{/each}
	</div>

	{#if $followingPeople.length}
		<h2 class="label" style="margin-top:24px;">Following ({$followingPeople.length})</h2>
		<div class="card" style="padding:16px 24px;">
			{#each $followingPeople as p (p.uid)}
				<div class="person">
					<Avatar uid={p.uid} name={p.name} size={30} />
					<span class="person-name">{p.name}</span>
					<button
						class="btn btn--ghost btn--sm"
						disabled={calling === p.uid}
						onclick={() => callUser(p.uid)}
						title="Video call {p.name}"
					>
						{calling === p.uid ? '📲 Calling…' : '📹 Call'}
					</button>
					<button
						class="btn btn--ghost btn--sm"
						onclick={() => follow.toggle(p.uid, p.name)}
						title="Unfollow {p.name}"
					>
						Unfollow
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.hint {
		margin: 8px 2px 0;
		font-size: 0.85rem;
	}
	.person {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 0;
	}
	.person-name {
		font-weight: 500;
	}
	.person > button {
		margin-left: auto;
	}
</style>

<script>
	import { untrack, onMount } from 'svelte';
	import Avatar from './Avatar.svelte';
	import UserPicker from './UserPicker.svelte';
	import { api } from '$lib/api.js';
	import { GAMES, gameById, seatedPlayerIds, playerCapacity } from '$lib/games.js';
	import { user } from '$lib/stores/auth.js';
	import { following, follow } from '$lib/stores/follow.js';

	let { store, members, room, isHost } = $props();
	const myUid = $derived($user?.uid);
	onMount(() => follow.load());
	let error = $state('');
	let starting = $state(false);
	let removing = $state(null); // member id being removed
	let promoting = $state(null); // member id being made host
	let reseating = $state(null); // member id whose seat is being changed
	let swapFor = $state(null); // member id waiting for a player to swap out
	let switching = $state(false);

	// ⋮ menus close the open one on any tap outside it — native <details> won't.
	// ponytail: one global listener closes all kebabs; fine for a short member list.
	$effect(() => {
		function onDown(e) {
			for (const d of document.querySelectorAll('details.kebab[open]')) {
				if (!d.contains(e.target)) d.open = false;
			}
		}
		document.addEventListener('pointerdown', onDown);
		return () => document.removeEventListener('pointerdown', onDown);
	});
	const closeMenu = (e) => e.currentTarget.closest('details')?.removeAttribute('open');

	const accepted = $derived(members.filter((m) => m.status === 'accepted'));
	const pending = $derived(members.filter((m) => m.status === 'pending'));
	const players = $derived(accepted.filter((m) => m.role === 'player'));
	const capacity = $derived(playerCapacity(room.gameType, room.maxPlayers));
	const seatsFull = $derived(players.length >= capacity);

	const needed = $derived(gameById(room.gameType).needs);

	/* ---- private room guest list -------------------------------------------
	   Host-only, and fetched separately rather than riding publicRoom: the room
	   row ships with every roster push and poll, and turning the many2many's bare
	   uids into names costs a res.users read. This is asked for once. */
	const isPrivateRoom = $derived(room.visibility === 'private');
	let allowed = $state([]); // [{ uid, name }]
	let invitesLoaded = $state(false);
	let inviting = $state(null); // uid being added or dropped

	$effect(() => {
		if (!isHost || !isPrivateRoom || invitesLoaded) return;
		invitesLoaded = true;
		api(`/api/rooms/${room.id}/invites`)
			.then((d) => (allowed = d.allowed))
			.catch((e) => (error = e.message));
	});

	/** Both verbs echo the whole new list back, so there's no follow-up GET. */
	async function invite(uid, action) {
		error = '';
		inviting = uid;
		try {
			const d = await api(`/api/rooms/${room.id}/invites`, { method: 'POST', body: { uid, action } });
			allowed = d.allowed;
			// dropping someone off the list also drops them from the room, and that
			// roster change arrives on the push rather than in this response
			if (action === 'remove') store.pollNow();
		} catch (e) {
			error = e.message;
		} finally {
			inviting = null;
		}
	}

	// Ring an invited (or absent) member's device — a push that opens this room so
	// they walk straight in. Video-call rooms especially want this from the lobby.
	const acceptedUids = $derived(new Set(accepted.map((m) => m.uid)));
	let ringing = $state(0);
	async function ring(uid) {
		if (ringing) return;
		ringing = uid;
		error = '';
		try {
			await store.post('call', { toUid: uid });
		} catch (e) {
			error = e.message;
		}
		setTimeout(() => (ringing = 0), 4000);
	}

	// What switching to `pick` would do to the seating, worked out client-side
	// from the same capacity rule the server applies — no extra request.
	// untracked seed + an effect that follows: the select is local (you can browse
	// options without switching) but must snap back to the truth when someone else
	// switches, or when our own POST fails.
	let pick = $state(untrack(() => room.gameType));
	let pickDraws = $state(untrack(() => room.drawsTotal) || 5);
	// only follow the truth when it actually changes — a background poll re-ingesting
	// the same gameType must not wipe an in-progress selection (native mobile <select>
	// stays open across a poll tick).
	let lastGameType = untrack(() => room.gameType);
	$effect(() => {
		if (room.gameType !== lastGameType) {
			lastGameType = room.gameType;
			pick = room.gameType;
		}
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

	/**
	 * Seat or unseat a member. `demoteMemberId` is the player giving up their seat
	 * when the table is already full — the host picks them rather than the server
	 * bumping whoever happens to sort last.
	 */
	async function setRole(m, role, demoteMemberId) {
		error = '';
		// A full table needs to know who steps down first, so ask before posting.
		// The server enforces the same rule (code 'no_seat'); this just saves the
		// round trip in the case the lobby can already see.
		if (role === 'player' && seatsFull && demoteMemberId == null) {
			swapFor = m.id;
			return;
		}
		reseating = m.id;
		try {
			await store.post('roles', { memberId: m.id, role, demoteMemberId });
			swapFor = null;
		} catch (e) {
			error = e.message;
			// someone else took the last seat between render and click
			if (e.code === 'no_seat') swapFor = m.id;
		} finally {
			reseating = null;
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
			<span class="row-actions">
			{#if m.uid !== myUid}
				<button
					class="btn btn--ghost btn--sm"
					onclick={() => follow.toggle(m.uid, m.name)}
					title={$following.has(m.uid) ? `Unfollow ${m.name}` : `Follow ${m.name}`}
				>
					{$following.has(m.uid) ? '✓ Following' : '+ Follow'}
				</button>
			{/if}
			{#if isHost}
				<details class="kebab">
					<summary class="btn btn--ghost btn--sm" title="Actions" aria-label="Actions">⋮</summary>
					<div class="kebab-panel">
						<!-- The seat toggle is the one control that also applies to the host's
						     OWN row: in chess the host holds one of the two seats, so sitting
						     out is how they free it for someone waiting. Host stays host. -->
						<button
							class="btn btn--ghost btn--sm"
							onclick={(e) => {
								closeMenu(e);
								setRole(m, m.role === 'player' ? 'spectator' : 'player');
							}}
							disabled={reseating === m.id}
							title={m.role === 'player'
								? `Move ${m.name} to the spectators`
								: `Give ${m.name} a player seat`}
						>
							{#if reseating === m.id}
								…
							{:else if m.role === 'player'}
								▼ Make spectator
							{:else}
								▲ Make player
							{/if}
						</button>
						{#if m.uid !== room.hostUid}
							<button
								class="btn btn--ghost btn--sm"
								onclick={(e) => {
									closeMenu(e);
									makeHost(m);
								}}
								disabled={promoting === m.id}
								title="Make {m.name} the host of this room"
							>
								{promoting === m.id ? '…' : '👑 Make host'}
							</button>
							<button
								class="btn btn--ghost btn--sm"
								onclick={(e) => {
									closeMenu(e);
									remove(m);
								}}
								disabled={removing === m.id}
								title="Remove {m.name} from this room"
							>
								{removing === m.id ? '…' : 'Remove'}
							</button>
						{/if}
					</div>
				</details>
			{/if}
			</span>
		</div>
		{#if swapFor === m.id}
			<!-- Every seat is taken, so seating this member means unseating another.
			     Naming the swap here keeps it one confirmed action rather than
			     "demote someone, then remember to come back and promote". -->
			<div class="swap-row">
				<span class="muted">Seats are full — who steps down for {m.name}?</span>
				{#each players as p (p.id)}
					<button
						class="btn btn--sm"
						onclick={() => setRole(m, 'player', p.id)}
						disabled={reseating === m.id}
					>
						Swap out {p.name}
					</button>
				{/each}
				<button class="btn btn--ghost btn--sm" onclick={() => (swapFor = null)}>Cancel</button>
			</div>
		{/if}
	{/each}

	{#if error}<p class="error-text">{error}</p>{/if}

	{#if isHost && isPrivateRoom}
		<!-- Host only. Everyone here can see the room in their browse list and walks
		     straight in — no join request. Taking someone off the list also takes
		     them out of the room, so the list stays the single source of truth. -->
		<hr style="border-color:var(--border); margin:14px 0;" />
		<h3 class="label" style="margin-top:0;">🔒 Invited players ({allowed.length})</h3>
		{#each allowed as u (u.uid)}
			<div class="member-row">
				<Avatar uid={u.uid} name={u.name} size={26} />
				<span class="member-name">{u.name}</span>
				{#if u.uid === room.hostUid}<span class="chip chip--amber">you</span>{/if}
				{#if u.uid !== room.hostUid}
					{#if !acceptedUids.has(u.uid)}
						<button
							class="btn btn--ghost btn--sm invite-btn"
							onclick={() => ring(u.uid)}
							disabled={ringing === u.uid}
							title="Call {u.name} to join"
						>
							{ringing === u.uid ? '📲 Ringing…' : '📹 Call'}
						</button>
					{/if}
					<button
						class="btn btn--ghost btn--sm invite-btn"
						onclick={() => invite(u.uid, 'remove')}
						disabled={inviting === u.uid}
						title="{u.name} loses access to this room"
					>
						{inviting === u.uid ? '…' : 'Uninvite'}
					</button>
				{/if}
			</div>
		{/each}
		<div style="margin-top:8px;">
			<UserPicker
				selected={allowed}
				showChips={false}
				placeholder="Add someone by name…"
				onpick={(u) => invite(u.uid, 'add')}
			/>
		</div>
	{/if}

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
		<p class="muted" style="margin-top:8px;">
			Needs {needed}. {players.length} of {capacity} seat{capacity === 1 ? '' : 's'} taken.
		</p>
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
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* trailing controls (Follow + host ⋮) take the slack, right-aligned */
	.row-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.kebab {
		position: relative;
	}
	.kebab > summary {
		list-style: none;
		cursor: pointer;
		line-height: 1;
	}
	.kebab > summary::-webkit-details-marker {
		display: none;
	}
	.kebab-panel {
		position: absolute;
		right: 0;
		top: 100%;
		z-index: 10;
		margin-top: 4px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px;
		min-width: 150px;
		max-width: min(220px, calc(100vw - 24px));
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: var(--shadow-sm);
	}
	.kebab-panel .btn {
		justify-content: flex-start;
		width: 100%;
	}
	.invite-btn {
		margin-left: auto;
	}
	.swap-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		padding: 4px 0 8px 40px;
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

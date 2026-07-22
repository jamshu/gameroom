<script>
	import Avatar from './Avatar.svelte';

	let { store, game, members, myUid, isHost } = $props();
	let error = $state('');
	let busy = $state(false);

	const nameOf = $derived((uid) => members.find((m) => m.uid === Number(uid))?.name || `#${uid}`);
	const isPolice = $derived(game.policeUid === myUid);
	const amPlayer = $derived(game.players.includes(myUid));

	const ROLE_EMOJI = {
		King: '👑', Queen: '👸', Minister: '🎩', Soldier: '⚔️', Sepoy: '🪖',
		Guard: '🛡️', Farmer: '🌾', Trader: '⚖️', Barber: '✂️', Cobbler: '🥾',
		Police: '👮', Thief: '🥷'
	};

	async function act(path, body) {
		error = '';
		busy = true;
		try {
			await store.post(path, body || {});
		} catch (e) {
			error = e.message;
		} finally {
			busy = false;
		}
	}

	const sortedTotals = $derived(
		Object.entries(game.totals || {}).sort((a, b) => b[1] - a[1])
	);
</script>

<div class="card" style="padding:20px;">
	<div class="tf-head">
		<h2 class="section-title" style="margin:0;">🕵️ Thief Finder</h2>
		<span class="chip chip--accent">Draw {game.draw}/{game.drawsTotal}</span>
	</div>

	{#if error}<p class="error-text">{error}</p>{/if}

	{#if game.phase === 'idle'}
		<p class="muted">Ready to deal the first draw.</p>
		{#if isHost}
			<button class="btn btn--primary" onclick={() => act('thief/deal')} disabled={busy}>Deal cards</button>
		{:else}
			<p class="muted">Waiting for the host to deal…</p>
		{/if}
	{:else if game.phase === 'guessing'}
		{#if amPlayer && game.myRole}
			<div class="my-card fade-in">
				<span class="my-card-emoji">{ROLE_EMOJI[game.myRole]}</span>
				<div>
					<p class="label" style="margin:0;">Your card (secret)</p>
					<strong style="font-size:1.3rem;">{game.myRole}</strong>
				</div>
			</div>
		{/if}

		<p style="margin:14px 0;">
			👮 <strong>{nameOf(game.policeUid)}</strong> is the Police{isPolice ? ' — that’s you! Find the thief:' : '. Waiting for their guess…'}
		</p>

		{#if isPolice}
			<div class="suspects">
				{#each game.players.filter((u) => u !== myUid) as uid (uid)}
					<button class="btn suspect" onclick={() => act('thief/guess', { accusedUid: uid })} disabled={busy}>
						<Avatar {uid} name={nameOf(uid)} size={40} />
						<span>{nameOf(uid)}</span>
					</button>
				{/each}
			</div>
		{/if}
	{:else if game.phase === 'reveal' || game.phase === 'finished'}
		{#if game.lastResult}
			<div class="fade-in">
				<p style="font-size:1.05rem;">
					{#if game.lastResult.correct}
						✅ Police caught the thief! <strong>{nameOf(game.lastResult.thiefUid)}</strong> was the 🥷 Thief.
					{:else}
						❌ Wrong guess! Police accused <strong>{nameOf(game.lastResult.accusedUid)}</strong>,
						but <strong>{nameOf(game.lastResult.thiefUid)}</strong> was the 🥷 Thief — thief takes the points!
					{/if}
				</p>
				<div class="reveal-grid">
					{#each Object.entries(game.lastResult.roles) as [uid, role] (uid)}
						<div class="reveal-row">
							<Avatar uid={Number(uid)} name={nameOf(uid)} size={26} />
							<span>{nameOf(uid)}</span>
							<span class="chip">{ROLE_EMOJI[role]} {role}</span>
							<span class="pts">+{game.lastResult.points[uid]}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		{#if game.phase === 'reveal'}
			{#if isHost}
				<button class="btn btn--primary" style="margin-top:14px;" onclick={() => act('thief/deal')} disabled={busy}>
					Next draw ({game.draw + 1}/{game.drawsTotal})
				</button>
			{:else}
				<p class="muted" style="margin-top:12px;">Waiting for the host to deal the next draw…</p>
			{/if}
		{/if}
	{/if}

	<h3 class="label" style="margin-top:20px;">Scores</h3>
	{#each sortedTotals as [uid, pts], i (uid)}
		<div class="score-row">
			<span class="rank">{i + 1}</span>
			<Avatar uid={Number(uid)} name={nameOf(uid)} size={24} />
			<span>{nameOf(uid)}{Number(uid) === myUid ? ' (you)' : ''}</span>
			<span class="pts">{pts}</span>
		</div>
	{/each}
</div>

<style>
	.tf-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 14px;
	}
	.my-card {
		display: flex;
		align-items: center;
		gap: 14px;
		background: var(--surface);
		border: 1px dashed var(--accent);
		border-radius: var(--radius);
		padding: 14px;
	}
	.my-card-emoji {
		font-size: 2.2rem;
	}
	.suspects {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.suspect {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 12px 18px;
	}
	.reveal-grid {
		margin-top: 10px;
	}
	.reveal-row,
	.score-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 0;
	}
	.pts {
		margin-left: auto;
		font-weight: 700;
		color: var(--gold);
	}
	.rank {
		width: 18px;
		color: var(--text-dim);
	}
</style>

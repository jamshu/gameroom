<script>
	import Avatar from './Avatar.svelte';

	let { members, game = null, store = null, isHost = false } = $props();
	let busy = $state(false);
	let error = $state('');

	const ranked = $derived(
		members
			.filter((m) => m.status === 'accepted' && m.role === 'player')
			.sort((a, b) => b.score - a.score)
	);
	const topScore = $derived(ranked[0]?.score ?? 0);

	async function playAgain() {
		error = '';
		busy = true;
		try {
			await store.post('rematch', {});
		} catch (e) {
			error = e.message;
		} finally {
			busy = false;
		}
	}
</script>

<div class="card" style="padding:24px; text-align:center;">
	<h2 class="section-title" style="margin-top:0;">🏆 Final leaderboard</h2>
	{#each ranked as m, i (m.uid)}
		{@const winner = m.score === topScore && topScore > 0}
		<div class="lb-row {winner ? 'lb-row--winner' : ''}">
			<span class="lb-rank">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span>
			<Avatar uid={m.uid} name={m.name} size={38} ring={winner ? 'gold' : 'none'} glow={winner} />
			<span class="lb-name">{m.name}</span>
			<span class="lb-score">{m.score}</span>
		</div>
	{:else}
		<p class="muted">No scores recorded.</p>
	{/each}

	{#if error}<p class="error-text">{error}</p>{/if}

	<div class="lb-actions">
		{#if isHost && store}
			<button class="btn btn--primary" onclick={playAgain} disabled={busy}>
				{busy ? 'Resetting…' : '🔄 Play again'}
			</button>
		{:else}
			<p class="muted" style="margin:0;">Waiting for host to start a new round…</p>
		{/if}
		<a class="btn btn--ghost" href="/">Back to rooms</a>
	</div>
</div>

<style>
	.lb-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		border-radius: var(--radius-sm);
		text-align: left;
	}
	.lb-row--winner {
		background: var(--surface);
		border: 1px solid var(--gold);
	}
	.lb-rank {
		width: 30px;
		font-size: 1.1rem;
	}
	.lb-name {
		font-weight: 600;
	}
	.lb-score {
		margin-left: auto;
		font-weight: 700;
		color: var(--gold);
		font-size: 1.1rem;
	}
	.lb-actions {
		display: flex;
		gap: 10px;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		margin-top: 18px;
	}
</style>

<script>
	import Avatar from './Avatar.svelte';

	let { members, game = null } = $props();

	const ranked = $derived(
		members
			.filter((m) => m.status === 'accepted' && m.role === 'player')
			.sort((a, b) => b.score - a.score)
	);
	const topScore = $derived(ranked[0]?.score ?? 0);
</script>

<div class="card" style="padding:24px; text-align:center;">
	<h2 class="section-title" style="margin-top:0;">🏆 Final leaderboard</h2>
	{#each ranked as m, i (m.uid)}
		<div class="lb-row {m.score === topScore && topScore > 0 ? 'lb-row--winner' : ''}">
			<span class="lb-rank">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span>
			<Avatar uid={m.uid} name={m.name} size={34} />
			<span class="lb-name">{m.name}</span>
			<span class="lb-score">{m.score}</span>
		</div>
	{:else}
		<p class="muted">No scores recorded.</p>
	{/each}
	<a class="btn btn--primary" style="margin-top:18px;" href="/">Back to rooms</a>
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
</style>

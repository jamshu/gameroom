<script>
	import Avatar from './Avatar.svelte';

	/**
	 * The room's running tally: one point per game won, carried across every
	 * rematch for as long as you stay in the room.
	 *
	 * Distinct from Leaderboard, which shows the score of the ROUND just played
	 * and only exists while the room is `finished`. This one is mounted outside
	 * the status-gated pane on purpose, so the standings are on screen in the
	 * lobby, mid-game and after — a tally you can only see between games is not
	 * much of a tally.
	 */
	let { members = [], wins = {} } = $props();

	// Driven by the members list, not by the keys of `wins`: someone who has left
	// is cleaned out of `wins` server-side, and reading the roster means a stale
	// entry can never render as a ghost row either way.
	const ranked = $derived(
		members
			.filter((m) => m.status === 'accepted' && (wins[m.uid] || 0) > 0)
			.map((m) => ({ ...m, points: wins[m.uid] || 0 }))
			.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
	);
	const leader = $derived(ranked[0]?.points ?? 0);
</script>

{#if ranked.length}
	<div class="scoreboard">
		<span class="sb-label">🏆 Wins</span>
		{#each ranked as m (m.uid)}
			<span class="sb-player" class:sb-player--top={m.points === leader}>
				<Avatar uid={m.uid} name={m.name} size={22} />
				<span class="sb-name">{m.name}</span>
				<b class="sb-points">{m.points}</b>
			</span>
		{/each}
	</div>
{/if}

<style>
	.scoreboard {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px 14px;
		margin-bottom: 14px;
		padding: 8px 12px;
		border: 2px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}
	.sb-label {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.86rem;
		opacity: 0.75;
	}
	.sb-player {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.9rem;
	}
	.sb-name {
		max-width: 10ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sb-points {
		font-family: var(--font-display);
		min-width: 1.2em;
		text-align: center;
	}
	.sb-player--top .sb-points {
		color: var(--accent);
	}
</style>

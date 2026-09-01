<script>
	// Solo bird sort — entirely local. No room, no Durable Object, no socket: the
	// puzzle is generated in the tab and pours are applied against the local rules.
	// Instant and playable offline (the route is precached; see /solo in the
	// layout's OPEN_ROUTES).
	//
	// The board component is the SAME one the multiplayer race uses. The only
	// difference is who answers `onMove`: here it's the local rules, there it's a
	// POST. Neither knows about the other.
	import { onDestroy } from 'svelte';
	import BirdsortBoard from '$lib/components/BirdsortBoard.svelte';
	import { genTubes, applyMove, isSolved } from '$lib/shared/birdsort.js';
	import { getBest, recordBest, formatDuration } from '$lib/solo-bests.js';

	let tubes = $state([]);
	let moves = $state(0);
	let startedAt = $state(0);
	let finishedMs = $state(null);
	let improved = $state(false);
	let best = $state(null);

	let now = $state(Date.now());
	const timer = setInterval(() => (now = Date.now()), 1000);
	onDestroy(() => clearInterval(timer));

	const elapsed = $derived(finishedMs ?? (startedAt ? now - startedAt : 0));
	const done = $derived(finishedMs != null);

	function newGame() {
		tubes = genTubes(`solo-${Date.now()}-${Math.random()}`);
		moves = 0;
		finishedMs = null;
		improved = false;
		startedAt = Date.now();
		now = Date.now();
		best = getBest('birdsort', 'classic');
	}

	/** The local answer to the board's `onMove`. Mirrors applyBirdsortMove. */
	function move(from, to) {
		if (done) return { ok: false };
		const next = applyMove(tubes, from, to);
		if (!next) return { ok: false };
		tubes = next;
		moves++;
		if (isSolved(next)) finish();
		return { ok: true };
	}

	function finish() {
		finishedMs = Date.now() - startedAt;
		const res = recordBest('birdsort', 'classic', finishedMs);
		best = res.best;
		improved = res.improved;
	}

	newGame();
</script>

<svelte:head><title>Solo Bird Sort · Gamerooms</title></svelte:head>

<div class="fade-in solo">
	<header class="solo-head">
		<a class="btn btn--ghost btn--sm" href="/" aria-label="Back">←</a>
		<h1 class="title">🐦 Bird Sort</h1>
		<span class="clock">{formatDuration(elapsed)}</span>
		<button type="button" class="btn btn--ghost btn--sm" onclick={() => newGame()}>New</button>
	</header>

	{#if best}
		<p class="muted best">Best: <strong>{formatDuration(best.value)}</strong></p>
	{/if}

	{#if done}
		<div class="card done-card">
			<h2>Sorted in {formatDuration(finishedMs)}</h2>
			<p class="muted">
				{moves} move{moves === 1 ? '' : 's'}.{improved ? ' 🏆 New personal best!' : ''}
			</p>
			<button type="button" class="btn btn--primary" onclick={() => newGame()}>Play again</button>
		</div>
	{/if}

	<BirdsortBoard {tubes} {done} onMove={move} />
</div>

<style>
	.solo {
		--board-cap: min(94vw, 640px);
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: center;
		padding-bottom: 24px;
	}
	.solo-head {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		max-width: var(--board-cap, 520px);
	}
	.title {
		margin: 0;
		font-size: 1.25rem;
		flex: 1;
		text-align: center;
	}
	.clock {
		font-variant-numeric: tabular-nums;
		font-weight: 700;
		color: var(--text-dim);
		min-width: 3.5em;
		text-align: right;
	}
	.best {
		margin: 0;
		font-size: 0.85rem;
	}
	.done-card {
		padding: 16px;
		text-align: center;
		width: 100%;
		max-width: var(--board-cap, 520px);
	}
	.done-card h2 {
		margin: 0 0 4px;
		font-size: 1.1rem;
	}
	.done-card .btn {
		margin-top: 10px;
	}
</style>

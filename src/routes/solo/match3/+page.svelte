<script>
	// Solo Candy Match — entirely local, like solo sudoku. The board is dealt from
	// a seed and every swap is resolved in the tab by the shared engine, so this
	// works offline (the route is precached; see /solo in the layout's
	// OPEN_ROUTES) and costs the server nothing.
	//
	// Uses the SAME board component as the race. Only `onSwap` differs.
	import { onDestroy } from 'svelte';
	import Match3Board from '$lib/components/Match3Board.svelte';
	import { openRound, applySwap, ROUND_MS } from '$lib/shared/match3.js';
	import { getBest, recordBest } from '$lib/solo-bests.js';

	/** Sprint matches the multiplayer round exactly, so solo doubles as practice.
	 *  Endless is the same game with the clock taken off. */
	const MODES = [
		{ id: 'sprint', label: `${ROUND_MS / 1000}s sprint`, ms: ROUND_MS },
		{ id: 'endless', label: 'Endless', ms: null }
	];

	let mode = $state('sprint');
	let board = $state([]);
	let score = $state(0);
	let startedAt = $state(0);
	let over = $state(false);
	let improved = $state(false);
	let best = $state(null);

	// The rng must survive across swaps — it IS the refill queue. A plain `let`,
	// not $state: it is mutated on every draw and nothing renders from it, so
	// making it reactive would invalidate the board on each tile.
	let rng = null;

	let now = $state(Date.now());
	const timer = setInterval(() => (now = Date.now()), 250);
	onDestroy(() => clearInterval(timer));

	const limitMs = $derived(MODES.find((m) => m.id === mode)?.ms ?? null);
	const timeLeftMs = $derived(limitMs == null ? null : Math.max(0, startedAt + limitMs - now));

	// The clock runs out in a derived tick rather than a setTimeout so that a
	// backgrounded tab (where timers are throttled) still ends the round at the
	// right SCORE — the elapsed time is recomputed from the wall clock, never
	// accumulated.
	$effect(() => {
		if (!over && limitMs != null && timeLeftMs === 0 && startedAt) finish();
	});

	function newGame(m = mode) {
		mode = m;
		const round = openRound(`solo-m3-${Date.now()}-${Math.random()}`);
		board = round.board;
		rng = round.rng;
		score = 0;
		over = false;
		improved = false;
		startedAt = Date.now();
		now = Date.now();
		best = getBest('match3', m);
	}

	function finish() {
		over = true;
		const res = recordBest('match3', mode, score);
		best = res.best;
		improved = res.improved;
	}

	/** The local answer to the board's `onSwap`. */
	function swap(a, b) {
		if (over) return { ok: false };
		const res = applySwap(board, a, b, rng);
		if (!res.ok) return { ok: false };
		board = res.board;
		score += res.gained;
		return { ok: true, gained: res.gained, cascades: res.cascades };
	}

	newGame();
</script>

<svelte:head><title>Solo Candy Match · Gamerooms</title></svelte:head>

<div class="fade-in solo">
	<header class="solo-head">
		<a class="btn btn--ghost" href="/">← Back</a>
		<h1 class="title">🍬 Candy Match</h1>
	</header>

	<div class="controls card">
		<div class="modes" role="radiogroup" aria-label="Mode">
			{#each MODES as m}
				<button
					type="button"
					class="btn"
					class:btn--primary={mode === m.id}
					class:btn--ghost={mode !== m.id}
					role="radio"
					aria-checked={mode === m.id}
					onclick={() => newGame(m.id)}
				>
					{m.label}
				</button>
			{/each}
		</div>
		<button type="button" class="btn btn--ghost" onclick={() => newGame()}>Restart</button>
	</div>

	{#if best}
		<p class="muted best">Best {mode}: <strong>{best.value.toLocaleString()}</strong></p>
	{/if}

	{#if over}
		<div class="card done-card">
			<h2>Time! {score.toLocaleString()} points</h2>
			{#if improved}<p class="muted">🏆 New personal best!</p>{/if}
			<button type="button" class="btn btn--primary" onclick={() => newGame()}>Play again</button>
		</div>
	{/if}

	<Match3Board {board} {score} {timeLeftMs} disabled={over} onSwap={swap} />
</div>

<style>
	.solo {
		display: flex;
		flex-direction: column;
		gap: 14px;
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
	.controls {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		justify-content: center;
		padding: 10px;
		width: 100%;
		max-width: var(--board-cap, 520px);
	}
	.modes {
		display: flex;
		gap: 6px;
	}
	.best {
		margin: 0;
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

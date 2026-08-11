<script>
	// Solo sudoku — entirely local. No room, no Durable Object, no Odoo row, no
	// socket: the puzzle is generated in the tab and validated against the
	// solution held in this component. That is what makes it instant and playable
	// offline (the route is precached; see /solo in the layout's OPEN_ROUTES).
	//
	// The board component is the SAME one the multiplayer race uses. The only
	// difference is who answers `onFill`: here it's the local solution, there
	// it's a POST. Neither knows about the other.
	import { onDestroy } from 'svelte';
	import SudokuBoard from '$lib/components/SudokuBoard.svelte';
	// FREEZE_MS is imported, not redeclared: the wrong-entry penalty must be the
	// same one the race enforces, or solo would teach the wrong reflexes.
	import { generate, DIFFICULTIES, isComplete, FREEZE_MS } from '$lib/shared/sudoku.js';
	import { getBest, recordBest, formatDuration } from '$lib/solo-bests.js';

	let difficulty = $state('medium');
	let game = $state(null); // { puzzle, solution }
	let filled = $state({});
	let mistakes = $state(0);
	let frozenUntil = $state(0);
	let startedAt = $state(0);
	let finishedMs = $state(null);
	let improved = $state(false);
	let best = $state(null);

	// a 1s tick so the elapsed clock moves while a puzzle is live
	let now = $state(Date.now());
	const timer = setInterval(() => (now = Date.now()), 1000);
	onDestroy(() => clearInterval(timer));

	const elapsed = $derived(finishedMs ?? (startedAt ? now - startedAt : 0));
	const done = $derived(finishedMs != null);

	function newGame(d = difficulty) {
		difficulty = d;
		// A fresh seed per deal — otherwise "New puzzle" would hand back the grid
		// the player has just solved.
		game = generate(`solo-${d}-${Date.now()}-${Math.random()}`, d);
		filled = {};
		mistakes = 0;
		frozenUntil = 0;
		finishedMs = null;
		improved = false;
		startedAt = Date.now();
		now = Date.now();
		best = getBest('sudoku', d);
	}

	/**
	 * The local answer to the board's `onFill`. Mirrors the server's sudokuFill:
	 * a wrong digit is rejected rather than placed, so a full grid is a correct
	 * grid and there is never anything to erase.
	 */
	function fill(cell, digit) {
		if (done || Date.now() < frozenUntil) return { ok: false };
		if (game.solution[cell] !== digit) {
			mistakes++;
			frozenUntil = Date.now() + FREEZE_MS;
			return { ok: true, correct: false };
		}
		filled = { ...filled, [cell]: digit };
		if (isComplete(game.puzzle, filled)) finish();
		return { ok: true, correct: true };
	}

	function finish() {
		finishedMs = Date.now() - startedAt;
		const res = recordBest('sudoku', difficulty, finishedMs);
		best = res.best;
		improved = res.improved;
	}

	newGame();
</script>

<svelte:head><title>Solo Sudoku · Gamerooms</title></svelte:head>

<div class="fade-in solo">
	<header class="solo-head">
		<a class="btn btn--ghost btn--sm" href="/" aria-label="Back">←</a>
		<h1 class="title">🔢 Sudoku</h1>
		<span class="clock">{formatDuration(elapsed)}</span>
		<details class="game-menu">
			<summary class="btn btn--ghost btn--sm" title="Difficulty & new puzzle">⚙️ {difficulty}</summary>
			<div class="menu-pop card">
				<span class="menu-label">Difficulty</span>
				<div class="diffs" role="radiogroup" aria-label="Difficulty">
					{#each DIFFICULTIES as d}
						<button
							type="button"
							class="btn btn--sm"
							class:btn--primary={difficulty === d}
							class:btn--ghost={difficulty !== d}
							role="radio"
							aria-checked={difficulty === d}
							onclick={() => newGame(d)}
						>
							{d}
						</button>
					{/each}
				</div>
				<button type="button" class="btn btn--ghost btn--sm" onclick={() => newGame()}>New puzzle</button>
				{#if best}
					<p class="muted best">Best {difficulty}: <strong>{formatDuration(best.value)}</strong></p>
				{/if}
			</div>
		</details>
	</header>

	{#if done}
		<div class="card done-card">
			<h2>Solved in {formatDuration(finishedMs)}</h2>
			<p class="muted">
				{mistakes === 0 ? 'Flawless — no mistakes.' : `${mistakes} mistake${mistakes === 1 ? '' : 's'}.`}
				{improved ? ' 🏆 New personal best!' : ''}
			</p>
			<button type="button" class="btn btn--primary" onclick={() => newGame()}>Play again</button>
		</div>
	{/if}

	{#if game}
		<SudokuBoard
			puzzle={game.puzzle}
			{filled}
			{mistakes}
			{frozenUntil}
			{done}
			onFill={fill}
		/>
	{/if}
</div>

<style>
	.solo {
		/* full canvas: bounded only by width and by keeping the keypad in view
		   (svh), with the controls folded into the header menu so they cost no
		   vertical room */
		--board-cap: min(94vw, calc(100svh - 190px), 860px);
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
	/* difficulty + new-puzzle folded into a kebab so the board gets the room */
	.game-menu {
		position: relative;
	}
	.game-menu > summary {
		list-style: none;
		cursor: pointer;
		text-transform: capitalize;
	}
	.game-menu > summary::-webkit-details-marker {
		display: none;
	}
	.menu-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		min-width: 210px;
		box-shadow: var(--shadow-lg);
	}
	.menu-label {
		font-size: 0.8rem;
		color: var(--text-dim);
	}
	.diffs {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.diffs .btn {
		text-transform: capitalize;
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

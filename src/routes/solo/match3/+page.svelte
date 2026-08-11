<script>
	// Solo Candy Survival — candies drop from the top and pile up in their columns
	// (bottom gravity, no auto-refill). Swap adjacent candies to clear matches and
	// make room. When the box fills to the top, it's game over. Entirely local and
	// offline (the route is precached; see /solo in the layout's OPEN_ROUTES).
	//
	// The multiplayer race is a different game (the timed sprint on the shared
	// deterministic engine) and is untouched — this uses its own solo engine.
	import { onDestroy } from 'svelte';
	import Match3Board from '$lib/components/Match3Board.svelte';
	import { dealStart, applySwap, settleSteps, dropTick, isFull } from '$lib/survival-match3.js';
	import { getBest, recordBest } from '$lib/solo-bests.js';

	const START_ROWS = 4; // how many bottom rows the deal fills
	const DROP_MS = 1300; // cadence of a new drop

	let board = $state([]);
	let score = $state(0);
	let over = $state(false);
	let improved = $state(false);
	let best = $state(null);

	// animation state handed to the board
	let clearing = $state([]);
	let praise = $state(null);
	let dropping = $state([]);
	let animating = false; // plain let — guards re-entry, nothing renders from it

	// more candies per drop as the score climbs — the pressure ramps up
	const dropCount = $derived(Math.min(4, 2 + Math.floor(score / 1500)));

	const PRAISE = ['Good', 'Great!', 'Sweet!', 'Combo!'];
	const praiseFor = (depth) => ({ text: PRAISE[Math.min(depth, PRAISE.length) - 1], depth });
	const reduceMotion =
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const delay = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));

	let dropTimer = null;

	function newGame() {
		board = dealStart(START_ROWS);
		score = 0;
		over = false;
		improved = false;
		clearing = [];
		praise = null;
		dropping = [];
		animating = false;
		best = getBest('match3', 'survival');
		clearInterval(dropTimer);
		dropTimer = setInterval(tick, DROP_MS);
	}

	function finish() {
		over = true;
		clearInterval(dropTimer);
		dropTimer = null;
		const res = recordBest('match3', 'survival', score);
		best = res.best;
		improved = res.improved;
	}

	onDestroy(() => clearInterval(dropTimer));

	/** Play out a cascade as pop-then-fall steps, updating the score as it goes. */
	async function animateSteps(swapped, steps, finalBoard) {
		if (swapped) {
			board = swapped;
			await delay(110);
		}
		for (const st of steps) {
			clearing = st.matched;
			praise = praiseFor(st.depth);
			score += st.gained;
			await delay(260);
			clearing = [];
			board = st.collapsed;
			await delay(150);
		}
		board = finalBoard;
		praise = null;
	}

	/** A new drop lands. Skipped while a swap/cascade is mid-animation — that just
	 *  grants the player a beat, and avoids racing the board state. */
	async function tick() {
		if (over || animating) return;
		animating = true;
		try {
			const t = dropTick(board, dropCount);
			if (t.over) {
				board = t.board;
				finish();
				return;
			}
			dropping = t.placed;
			board = t.board;
			await delay(260);
			dropping = [];
			// a drop can land straight into a match
			const res = settleSteps(board);
			if (res.steps.length) await animateSteps(null, res.steps, res.board);
		} finally {
			animating = false;
		}
	}

	/** The board's `onSwap`. Awaited, so the whole cascade animates before it
	 *  returns and the board stays input-locked (`busy`) until it does. */
	async function swap(a, b) {
		if (over || animating) return { ok: false };
		const res = applySwap(board, a, b);
		if (!res.ok) return { ok: false };
		animating = true;
		try {
			await animateSteps(res.swapped, res.steps, res.board);
		} finally {
			animating = false;
		}
		return { ok: true, gained: res.gained, cascades: res.cascades };
	}

	newGame();
</script>

<svelte:head><title>Solo Candy Survival · Gamerooms</title></svelte:head>

<div class="fade-in solo">
	<header class="solo-head">
		<a class="btn btn--ghost btn--sm" href="/" aria-label="Back">←</a>
		<h1 class="title">🍬 Candy Survival</h1>
		<details class="game-menu">
			<summary class="btn btn--ghost btn--sm" title="New game">⚙️</summary>
			<div class="menu-pop card">
				<button type="button" class="btn btn--primary btn--sm" onclick={newGame}>New game</button>
				{#if best}
					<p class="muted best">Best: <strong>{best.value.toLocaleString()}</strong></p>
				{/if}
				<p class="muted hint">Clear matches to keep the box from filling to the top.</p>
			</div>
		</details>
	</header>

	{#if over}
		<div class="card done-card">
			<h2>Box full! {score.toLocaleString()} points</h2>
			{#if improved}<p class="muted">🏆 New personal best!</p>{/if}
			<button type="button" class="btn btn--primary" onclick={newGame}>Play again</button>
		</div>
	{/if}

	<Match3Board {board} {score} {clearing} {praise} {dropping} disabled={over} onSwap={swap} />
</div>

<style>
	.solo {
		/* full canvas: bounded by width and by staying in view (svh); controls fold
		   into the header menu so they cost no vertical room */
		--board-cap: min(94vw, calc(100svh - 140px), 900px);
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
	/* new-game + best folded into a kebab so the board gets the room */
	.game-menu {
		position: relative;
	}
	.game-menu > summary {
		list-style: none;
		cursor: pointer;
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
		min-width: 220px;
		box-shadow: var(--shadow-lg);
	}
	.best {
		margin: 0;
		font-size: 0.85rem;
	}
	.hint {
		margin: 0;
		font-size: 0.78rem;
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

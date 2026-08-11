<script>
	// The sudoku grid, used by BOTH the solo page and the multiplayer race.
	//
	// It owns no game state — only selection and the transient "that was wrong"
	// flash. `filled` and `mistakes` come down as props and every entry goes back
	// out through `onFill`, so the solo page can answer from the local solution
	// while the room page POSTs to the server. Neither host has to know how the
	// other validates, and the rules live in exactly one place per mode.
	//
	// Wrong digits are REJECTED rather than placed (see the plan): the grid is
	// therefore always valid, a full grid is a correct grid, and there is nothing
	// to erase. That is why there is no eraser key.
	import { onDestroy } from 'svelte';
	import { playCorrect, playWrong, arm } from '$lib/sound.js';
	import { rowOf, colOf, boxOf, progressOf } from '$lib/shared/sudoku.js';

	let {
		puzzle,
		filled = {},
		mistakes = 0,
		frozenUntil = 0,
		disabled = false,
		done = false,
		rivals = [],
		onFill
	} = $props();

	let selected = $state(null);
	let wrongAt = $state(null); // cell index flashing red
	let wrongDigit = $state(null); // shown in that cell until the flash ends
	let wrongTimer = null;
	let busy = $state(false);

	// Ticks only while frozen, so the countdown is live without a permanent timer.
	let now = $state(Date.now());
	let freezeTimer = null;

	const progress = $derived(progressOf(puzzle ?? [], filled));
	const frozenMs = $derived(Math.max(0, (frozenUntil || 0) - now));
	const isFrozen = $derived(frozenMs > 0);
	const locked = $derived(disabled || done || isFrozen || busy);

	$effect(() => {
		// re-arm whenever a freeze starts; clear it the moment one ends
		if (frozenUntil > Date.now()) {
			if (!freezeTimer) freezeTimer = setInterval(() => (now = Date.now()), 200);
		} else if (freezeTimer) {
			clearInterval(freezeTimer);
			freezeTimer = null;
		}
	});

	onDestroy(() => {
		clearInterval(freezeTimer);
		clearTimeout(wrongTimer);
	});

	const isGiven = (i) => puzzle?.[i] !== 0;
	const digitAt = (i) => (isGiven(i) ? puzzle[i] : (filled?.[i] ?? 0));

	/** Cells sharing a row, column or box with the selection — the standard
	 *  "where can this digit not go" highlight. */
	function isPeer(i) {
		if (selected == null || i === selected) return false;
		return rowOf(i) === rowOf(selected) || colOf(i) === colOf(selected) || boxOf(i) === boxOf(selected);
	}

	/** Every other cell showing the same digit as the selection. */
	function isSameDigit(i) {
		if (selected == null || i === selected) return false;
		const d = digitAt(selected);
		return d !== 0 && digitAt(i) === d;
	}

	function selectCell(i) {
		if (isGiven(i) || filled?.[i]) {
			// A filled cell is still worth selecting — it drives the peer highlight.
			selected = i;
			return;
		}
		selected = i;
	}

	async function enter(digit) {
		if (locked || selected == null) return;
		if (isGiven(selected) || filled?.[selected]) return;
		arm();

		const cell = selected;
		busy = true;
		try {
			const res = await onFill?.(cell, digit);
			// `undefined` from a host that doesn't report back is treated as accepted;
			// only an explicit `correct: false` flashes.
			if (res && res.correct === false) {
				flashWrong(cell, digit);
				playWrong();
			} else {
				playCorrect();
			}
		} catch {
			// A failed round trip is not a wrong answer — say nothing rather than
			// blaming the player for a dropped request.
		} finally {
			busy = false;
		}
	}

	function flashWrong(cell, digit) {
		clearTimeout(wrongTimer);
		wrongAt = cell;
		wrongDigit = digit;
		wrongTimer = setTimeout(() => {
			wrongAt = null;
			wrongDigit = null;
		}, 700);
	}

	function onKey(e) {
		if (locked) return;
		if (e.key >= '1' && e.key <= '9') {
			enter(Number(e.key));
			e.preventDefault();
			return;
		}
		if (selected == null) return;
		// arrow keys move the selection — a keyboard player shouldn't have to reach
		// for the mouse between every digit
		const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
		const m = moves[e.key];
		if (!m) return;
		const r = Math.min(8, Math.max(0, rowOf(selected) + m[0]));
		const c = Math.min(8, Math.max(0, colOf(selected) + m[1]));
		selected = r * 9 + c;
		e.preventDefault();
	}

	/** How many of each digit are still unplaced — a keypad button for a digit
	 *  that is already nine-times placed is dimmed rather than removed, so the
	 *  pad never reflows under the player's thumb mid-game. */
	/** 0..80 as a real array — Svelte's `#each` needs an iterable, and an
	 *  array-like `{ length: 81 }` is not one. */
	const CELLS = Array.from({ length: 81 }, (_, i) => i);

	const remaining = $derived.by(() => {
		const counts = new Array(10).fill(9);
		for (let i = 0; i < 81; i++) {
			const d = digitAt(i);
			if (d) counts[d]--;
		}
		return counts;
	});
</script>

<svelte:window on:keydown={onKey} />

<div class="sudoku">
	<div class="hud">
		<span class="stat" title="Cells completed">
			<strong>{progress.pct}%</strong>
			<small>{progress.done}/{progress.total}</small>
		</span>
		<span class="stat" class:stat--bad={mistakes > 0} title="Wrong entries">
			✗ <strong>{mistakes}</strong>
		</span>
		{#if isFrozen}
			<span class="stat stat--frozen">❄ {(frozenMs / 1000).toFixed(1)}s</span>
		{/if}
	</div>

	{#if rivals.length}
		<ul class="rivals">
			{#each rivals as r (r.uid)}
				<li class:done={r.done}>
					<span class="rname">{r.name}</span>
					<span class="bar"><i style="width:{r.pct}%"></i></span>
					<span class="rpct">{r.done ? '✓' : `${r.pct}%`}</span>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="grid" class:locked>
		{#each CELLS as i (i)}
			{@const d = i === wrongAt ? wrongDigit : digitAt(i)}
			<button
				type="button"
				class="cell"
				class:given={isGiven(i)}
				class:sel={selected === i}
				class:peer={isPeer(i)}
				class:same={isSameDigit(i)}
				class:wrong={wrongAt === i}
				class:r3={rowOf(i) % 3 === 2 && rowOf(i) !== 8}
				class:c3={colOf(i) % 3 === 2 && colOf(i) !== 8}
				onclick={() => selectCell(i)}
				aria-label={`row ${rowOf(i) + 1} column ${colOf(i) + 1}${d ? `, ${d}` : ', empty'}`}
			>
				{d || ''}
			</button>
		{/each}
	</div>

	<div class="pad">
		{#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as d}
			<button
				type="button"
				class="key"
				class:spent={remaining[d] <= 0}
				disabled={locked || selected == null}
				onclick={() => enter(d)}
			>
				{d}
			</button>
		{/each}
	</div>
</div>

<style>
	.sudoku {
		display: flex;
		flex-direction: column;
		gap: 10px;
		align-items: center;
	}

	.hud {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		justify-content: center;
	}
	.stat {
		display: inline-flex;
		align-items: baseline;
		gap: 5px;
		padding: 3px 10px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
	}
	.stat strong {
		color: var(--text);
	}
	.stat--bad strong {
		color: var(--red);
	}
	.stat--frozen {
		color: var(--red);
		border-color: color-mix(in srgb, var(--red) 55%, transparent);
		background: color-mix(in srgb, var(--red) 14%, transparent);
	}

	/* rival progress — the race ticker. Hidden entirely in solo (empty array). */
	.rivals {
		list-style: none;
		margin: 0;
		padding: 0;
		width: 100%;
		max-width: var(--board-cap, 520px);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.rivals li {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.85rem;
		color: var(--text-dim);
	}
	.rname {
		flex: 0 0 5.5em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bar {
		flex: 1;
		height: 6px;
		border-radius: 999px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		overflow: hidden;
	}
	.bar i {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.3s ease;
	}
	.rivals li.done .bar i {
		background: var(--green, #22c55e);
	}
	.rpct {
		flex: 0 0 2.5em;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(9, 1fr);
		aspect-ratio: 1;
		width: 100%;
		max-width: var(--board-cap, 520px);
		background: var(--border);
		gap: 1px;
		padding: 2px;
		border: 3px solid color-mix(in srgb, var(--border) 55%, #000);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-lg);
		/* digits size against the BOARD, not the viewport, so the same component
		   reads correctly at the room's smaller --board-cap and full width solo */
		container-type: inline-size;
	}
	.grid.locked {
		opacity: 0.75;
	}

	.cell {
		all: unset;
		display: grid;
		place-items: center;
		background: var(--surface);
		color: var(--accent);
		font-weight: 600;
		font-size: clamp(0.7rem, 5cqw, 1.5rem);
		cursor: pointer;
		aspect-ratio: 1;
		font-variant-numeric: tabular-nums;
	}
	/* the 3x3 box seams — a thicker edge on every third row/column */
	.cell.r3 {
		box-shadow: inset 0 -2px 0 0 color-mix(in srgb, var(--border) 90%, #000);
	}
	.cell.c3 {
		box-shadow: inset -2px 0 0 0 color-mix(in srgb, var(--border) 90%, #000);
	}
	.cell.r3.c3 {
		box-shadow:
			inset 0 -2px 0 0 color-mix(in srgb, var(--border) 90%, #000),
			inset -2px 0 0 0 color-mix(in srgb, var(--border) 90%, #000);
	}
	.cell.given {
		color: var(--text);
		font-weight: 800;
		cursor: default;
	}
	.cell.peer {
		background: color-mix(in srgb, var(--accent) 7%, var(--surface));
	}
	.cell.same {
		background: color-mix(in srgb, var(--accent) 20%, var(--surface));
	}
	.cell.sel {
		background: color-mix(in srgb, var(--accent) 32%, var(--surface));
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.cell.wrong {
		background: color-mix(in srgb, var(--red) 30%, var(--surface));
		color: var(--red);
		animation: shake 0.3s;
	}
	@keyframes shake {
		25% { transform: translateX(-2px); }
		75% { transform: translateX(2px); }
	}
	@media (prefers-reduced-motion: reduce) {
		.cell.wrong { animation: none; }
	}

	.pad {
		display: grid;
		grid-template-columns: repeat(9, 1fr);
		gap: 4px;
		width: 100%;
		max-width: var(--board-cap, 520px);
	}
	.key {
		all: unset;
		text-align: center;
		padding: 10px 0;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text);
		font-weight: 700;
		cursor: pointer;
		font-variant-numeric: tabular-nums;
	}
	.key:disabled {
		opacity: 0.4;
		cursor: default;
	}
	/* all nine placed — dimmed, never removed, so the pad can't reflow mid-game */
	.key.spent {
		opacity: 0.35;
	}
</style>

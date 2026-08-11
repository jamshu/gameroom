<script>
	// The match-3 grid, used by BOTH the solo page and the multiplayer race.
	//
	// Like SudokuBoard it owns no game state: `board` and `score` come down as
	// props and every attempted swap goes out through `onSwap`. The solo page
	// resolves it locally against the shared engine; the race page resolves it
	// locally too (the refill stream is client-side by design — see the plan) and
	// reports the running score over the ephemeral tick channel.
	//
	// Two ways to play a swap, because this is a phone-first game: tap one tile
	// then an adjacent one, or drag from a tile toward a neighbour. Both funnel
	// into `trySwap`.
	import { playWave, playCarromPocket, playWrong, arm } from '$lib/sound.js';
	import { SIZE, CELLS, areAdjacent } from '$lib/shared/match3.js';

	let {
		board = [],
		score = 0,
		timeLeftMs = null,
		disabled = false,
		rivals = [],
		// solo drives the cascade animation: `clearing` are the tile indices
		// popping out right now, `praise` is the escalating "Great!" banner,
		// `dropping` are freshly-spawned candies falling in (survival mode). The
		// race passes none — it settles atomically and these stay inert.
		clearing = [],
		praise = null,
		dropping = [],
		onSwap
	} = $props();

	/** Tile faces. Index = the kind stored in the board, so the engine never
	 *  knows about emoji and the art can change without touching the rules. */
	const FACES = ['🍬', '🍇', '🍋', '🍎', '🫐', '🍊'];

	const INDICES = Array.from({ length: CELLS }, (_, i) => i);

	let picked = $state(null);
	let rejected = $state(null); // tile index flashing "no"
	let rejectTimer = null;
	let busy = $state(false);

	/* The floating "+180" over the tile that was swapped.
	   Deliberately NOT a per-tile clear animation: `applySwap` reports which
	   cells matched, but they have already fallen and been refilled by the time
	   it returns, so animating those indices would light up whichever tiles
	   happen to have landed there. The gain is the honest thing to show. */
	let gain = $state(null); // { at, amount }
	let gainTimer = null;

	// drag state — plain lets, not $state: nothing renders from them mid-drag and
	// making them reactive would re-run effects on every pointermove.
	let dragFrom = null;
	let dragX = 0;
	let dragY = 0;

	const seconds = $derived(timeLeftMs == null ? null : Math.max(0, Math.ceil(timeLeftMs / 1000)));
	const locked = $derived(disabled || busy);

	async function trySwap(a, b) {
		if (locked || !areAdjacent(a, b)) {
			flashReject(a);
			return;
		}
		arm();
		busy = true;
		try {
			const res = await onSwap?.(a, b);
			if (res?.ok === false) {
				flashReject(b);
				playWrong();
			} else if (res?.ok) {
				// louder feedback the deeper the cascade ran
				if ((res.cascades ?? 1) > 1) playWave();
				else playCarromPocket('coin');
				showGain(b, res.gained);
			}
		} catch {
			/* a dropped request is not an illegal move — stay quiet */
		} finally {
			busy = false;
			picked = null;
		}
	}

	function flashReject(i) {
		clearTimeout(rejectTimer);
		rejected = i;
		rejectTimer = setTimeout(() => (rejected = null), 300);
	}

	function showGain(at, amount) {
		if (!amount) return;
		clearTimeout(gainTimer);
		gain = { at, amount };
		gainTimer = setTimeout(() => (gain = null), 650);
	}

	function tapTile(i) {
		if (locked) return;
		if (picked == null) {
			picked = i;
			return;
		}
		if (picked === i) {
			picked = null;
			return;
		}
		const from = picked;
		// Tapping a non-adjacent tile re-picks rather than failing — on a phone
		// that is nearly always a change of mind, not an attempted illegal move.
		if (!areAdjacent(from, i)) {
			picked = i;
			return;
		}
		trySwap(from, i);
	}

	function onPointerDown(e, i) {
		if (locked) return;
		dragFrom = i;
		dragX = e.clientX;
		dragY = e.clientY;
	}

	function onPointerUp(e) {
		const from = dragFrom;
		dragFrom = null;
		if (from == null || locked) return;

		const dx = e.clientX - dragX;
		const dy = e.clientY - dragY;
		// Below the threshold it was a tap, not a drag — let the click handler run.
		if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;

		// The dominant axis decides the direction; a drag off the edge of the board
		// is simply dropped rather than wrapping to the far side.
		let r = (from / SIZE) | 0;
		let c = from % SIZE;
		if (Math.abs(dx) > Math.abs(dy)) c += Math.sign(dx);
		else r += Math.sign(dy);

		picked = null;
		if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) trySwap(from, r * SIZE + c);
	}
</script>

<svelte:window on:pointerup={onPointerUp} />

<div class="m3">
	<div class="hud">
		<span class="stat"><small>Score</small> <strong>{score.toLocaleString()}</strong></span>
		{#if seconds != null}
			<span class="stat" class:stat--low={seconds <= 10}>
				⏱ <strong>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</strong>
			</span>
		{/if}
	</div>

	{#if rivals.length}
		<ul class="rivals">
			{#each rivals as r (r.uid)}
				<li>
					<span class="rname">{r.name}</span>
					<span class="rscore">{(r.score ?? 0).toLocaleString()}</span>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="grid" class:locked>
		{#each INDICES as i (i)}
			<button
				type="button"
				class="tile"
				class:picked={picked === i}
				class:rejected={rejected === i}
				class:vanishing={clearing.includes(i)}
				class:empty={board[i] == null}
				class:dropping={dropping.includes(i)}
				onpointerdown={(e) => onPointerDown(e, i)}
				onclick={() => tapTile(i)}
				aria-label={`tile ${i}`}
			>
				{FACES[board[i]] ?? ''}
				{#if gain?.at === i}
					<span class="gain">+{gain.amount}</span>
				{/if}
			</button>
		{/each}
		{#if praise}
			<span class="praise" data-depth={praise.depth}>{praise.text}</span>
		{/if}
	</div>
</div>

<style>
	.m3 {
		display: flex;
		flex-direction: column;
		gap: 10px;
		align-items: center;
		/* fill the host column so the board's width:100% has a definite basis —
		   a centred flex host would otherwise shrink us to content */
		width: 100%;
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
		font-size: 1.05rem;
	}
	.stat--low {
		color: var(--red);
		border-color: color-mix(in srgb, var(--red) 55%, transparent);
		background: color-mix(in srgb, var(--red) 14%, transparent);
	}
	.stat--low strong {
		color: var(--red);
	}

	.rivals {
		list-style: none;
		margin: 0;
		padding: 0;
		width: 100%;
		max-width: var(--board-cap, 520px);
		display: flex;
		gap: 8px;
		justify-content: center;
		flex-wrap: wrap;
	}
	.rivals li {
		display: flex;
		gap: 6px;
		align-items: baseline;
		font-size: 0.85rem;
		color: var(--text-dim);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 2px 8px;
	}
	.rname {
		max-width: 7em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rscore {
		font-variant-numeric: tabular-nums;
		color: var(--text);
		font-weight: 700;
	}

	.grid {
		position: relative; /* anchors the praise banner */
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		aspect-ratio: 1;
		width: 100%;
		max-width: var(--board-cap, 520px);
		gap: 2px;
		padding: 4px;
		background: var(--surface-2);
		border: 3px solid color-mix(in srgb, var(--border) 55%, #000);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-lg);
		container-type: inline-size;
		touch-action: none; /* swipe-to-swap must not scroll the page */
	}
	.grid.locked {
		opacity: 0.75;
	}

	.tile {
		all: unset;
		display: grid;
		place-items: center;
		aspect-ratio: 1;
		background: var(--surface);
		border-radius: var(--radius-sm);
		cursor: pointer;
		/* sized against the board, so it reads at the room's smaller --board-cap */
		font-size: clamp(0.9rem, 7cqw, 2rem);
		line-height: 1;
		user-select: none;
		transition: transform 0.12s ease, background 0.12s ease;
	}
	.tile.picked {
		background: color-mix(in srgb, var(--accent) 32%, var(--surface));
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		transform: scale(1.08);
	}
	.tile.rejected {
		background: color-mix(in srgb, var(--red) 28%, var(--surface));
	}
	/* the floating score gain — positioned against the tile it rose from */
	.tile {
		position: relative;
	}
	.gain {
		position: absolute;
		inset-block-start: 0;
		font-size: 0.7em;
		font-weight: 800;
		color: var(--accent);
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
		pointer-events: none;
		animation: rise 0.65s ease-out forwards;
	}
	@keyframes rise {
		to { transform: translateY(-140%); opacity: 0; }
	}

	/* a matched tile clearing: it flares bright, spins a touch and scales away,
	   so the run is SEEN to vanish instead of blinking to the refilled result */
	.tile.vanishing {
		animation: pop 0.26s ease-in forwards;
		z-index: 2;
	}
	@keyframes pop {
		30% { transform: scale(1.22); filter: brightness(1.7) saturate(1.3); }
		100% { transform: scale(0) rotate(28deg); filter: brightness(2); opacity: 0; }
	}

	/* an empty slot (survival mode) — recessed, so the pile reads against gaps */
	.tile.empty {
		background: color-mix(in srgb, var(--surface) 55%, #000);
		box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.35);
		cursor: default;
	}

	/* a freshly-dropped candy falling into place */
	.tile.dropping {
		animation: drop-in 0.28s cubic-bezier(0.3, 0.9, 0.4, 1);
	}
	@keyframes drop-in {
		0% { transform: translateY(-130%); opacity: 0.2; }
		70% { transform: translateY(6%); }
		100% { transform: translateY(0); opacity: 1; }
	}

	/* escalating cascade banner, centred over the board */
	.praise {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		pointer-events: none;
		font-family: var(--font-display, inherit);
		font-weight: 900;
		font-size: clamp(1.6rem, 14cqw, 3.4rem);
		color: var(--accent);
		text-shadow: 0 2px 0 rgba(0, 0, 0, 0.35), 0 0 18px color-mix(in srgb, var(--accent) 60%, transparent);
		animation: praise 0.62s ease-out forwards;
	}
	/* deeper cascades read hotter and land bigger */
	.praise[data-depth='2'] { color: #ffb020; }
	.praise[data-depth='3'] { color: #ff6ac1; }
	.praise[data-depth='4'] { color: #ff4d4d; }
	@keyframes praise {
		0% { transform: scale(0.4) rotate(-6deg); opacity: 0; }
		35% { transform: scale(1.15) rotate(-2deg); opacity: 1; }
		75% { transform: scale(1) rotate(0deg); opacity: 1; }
		100% { transform: scale(1.05); opacity: 0; }
	}

	@media (prefers-reduced-motion: reduce) {
		.tile { transition: none; }
		.gain { animation: none; }
		.tile.vanishing { animation: none; opacity: 0; }
		.tile.dropping { animation: none; }
		.praise { animation: none; opacity: 0.9; }
	}
</style>

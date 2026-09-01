<script>
	// The bird-sort tree, used by BOTH the solo page and the multiplayer race.
	//
	// Owns no game state — only the selection (tap a branch to pick up its outer
	// birds, tap another to move them). `tubes` comes down as a prop and every move
	// goes back out through `onMove(from, to)`, so the solo page can apply it
	// against the local rules while the room page POSTs to the server. Neither host
	// knows how the other validates.
	//
	// LAYOUT: each "tube" in the rules is a horizontal BRANCH off a central trunk.
	// Birds perch from the trunk (index 0) outward to the tip (last index); the tip
	// is the open, movable end — the "top" of the stack in tube terms.
	import { onDestroy } from 'svelte';
	import { playCorrect, playWrong, arm } from '$lib/sound.js';
	import { HEIGHT, progressOf } from '$lib/shared/birdsort.js';

	let { tubes = [], disabled = false, done = false, rivals = [], onMove } = $props();

	// One glyph + colour per bird kind. Colour AND shape both differ so the board
	// is readable for colour-blind players.
	const KINDS = [
		{ bg: '#ef4444', glyph: '🐦' },
		{ bg: '#f59e0b', glyph: '🐤' },
		{ bg: '#eab308', glyph: '🦆' },
		{ bg: '#22c55e', glyph: '🦜' },
		{ bg: '#3b82f6', glyph: '🕊️' },
		{ bg: '#a855f7', glyph: '🦉' }
	];

	let selected = $state(null); // index of the picked-up branch, or null
	let wrongAt = $state(null); // branch index flashing after an illegal move
	let wrongTimer = null;
	let busy = $state(false);

	const progress = $derived(progressOf(tubes));
	const locked = $derived(disabled || done || busy);

	// Branches alternate sides of the trunk, so the tree looks like a tree rather
	// than a comb. Left branches mirror (birds grow leftward from the trunk).
	const sideOf = (ti) => (ti % 2 === 0 ? 'right' : 'left');

	onDestroy(() => clearTimeout(wrongTimer));

	function flashWrong(i) {
		clearTimeout(wrongTimer);
		wrongAt = i;
		wrongTimer = setTimeout(() => (wrongAt = null), 400);
	}

	async function tap(i) {
		if (locked) return;
		arm();
		if (selected == null) {
			if (tubes[i]?.length) selected = i; // can't pick up an empty branch
			return;
		}
		if (i === selected) {
			selected = null; // tap the held branch again to put it back
			return;
		}
		const from = selected;
		selected = null;
		busy = true;
		try {
			const res = await onMove?.(from, i);
			if (res && res.ok === false) {
				flashWrong(from);
				playWrong();
			} else {
				playCorrect();
			}
		} catch {
			flashWrong(from);
		} finally {
			busy = false;
		}
	}

	// The outer same-colour run of the held branch lifts, so it's clear which birds
	// will fly before you commit.
	function isLifting(ti, bi) {
		if (ti !== selected) return false;
		const t = tubes[ti];
		if (!t?.length) return false;
		const top = t[t.length - 1];
		for (let k = t.length - 1; k >= 0; k--) {
			if (t[k] !== top) return bi > k;
		}
		return true; // whole branch is one colour
	}
</script>

<div class="birdsort">
	<div class="hud">
		<span class="stat" title="Branches sorted">
			<strong>{progress.pct}%</strong>
			<small>{progress.done}/{progress.total}</small>
		</span>
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

	<div class="tree" class:locked>
		<div class="trunk" aria-hidden="true"></div>
		<div class="branches">
			{#each tubes as tube, ti (ti)}
				<button
					type="button"
					class="branch {sideOf(ti)}"
					class:sel={selected === ti}
					class:wrong={wrongAt === ti}
					onclick={() => tap(ti)}
					aria-label={`Branch ${ti + 1}, ${tube.length} birds`}
				>
					<span class="twig"></span>
					<span class="perches">
						{#each Array(HEIGHT) as _, j (j)}
							{@const bird = tube[j]}
							<span
								class="perch"
								class:filled={bird != null}
								class:lift={bird != null && isLifting(ti, j)}
								style={bird != null ? `background:${KINDS[bird]?.bg}` : ''}
							>
								{bird != null ? (KINDS[bird]?.glyph ?? '') : ''}
							</span>
						{/each}
					</span>
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.birdsort {
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: center;
		width: 100%;
	}
	.hud {
		display: flex;
		gap: 8px;
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

	/* rival ticker — shared shape with SudokuBoard; hidden in solo (empty array) */
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

	/* --- the tree ------------------------------------------------------------ */
	.tree {
		position: relative;
		width: 100%;
		max-width: var(--board-cap, 520px);
		display: flex;
		justify-content: center;
		padding: 10px 0;
	}
	.tree.locked {
		opacity: 0.75;
	}
	/* central trunk running the height of the branch stack */
	.trunk {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 50%;
		width: 18px;
		transform: translateX(-50%);
		border-radius: 9px;
		background: linear-gradient(90deg, #6b4423, #8a5a2b, #6b4423);
		box-shadow: var(--shadow-lg);
	}
	.branches {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: 100%;
	}

	/* one branch = one tube. Right branches grow rightward, left ones mirror. */
	.branch {
		all: unset;
		display: flex;
		align-items: center;
		gap: 6px;
		width: 50%;
		cursor: pointer;
		padding: 4px 0;
	}
	.branch.right {
		align-self: flex-end;
		flex-direction: row;
		padding-left: 9px; /* clear the trunk */
	}
	.branch.left {
		align-self: flex-start;
		flex-direction: row-reverse;
		padding-right: 9px;
	}

	/* the woody twig the birds perch on */
	.twig {
		flex: 0 0 14px;
		height: 6px;
		border-radius: 3px;
		background: #8a5a2b;
	}
	.branch.right .twig {
		border-radius: 0 3px 3px 0;
	}
	.branch.left .twig {
		border-radius: 3px 0 0 3px;
	}

	.perches {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1;
	}
	.branch.left .perches {
		flex-direction: row-reverse; /* index 0 stays nearest the trunk */
	}

	.perch {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		flex: 0 0 34px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--border) 22%, transparent);
		font-size: 1rem;
		transition: transform 0.15s ease;
	}
	.perch.filled {
		box-shadow: inset 0 -3px 6px rgba(0, 0, 0, 0.25);
	}
	/* the outer run of the held branch rises, as if about to take flight */
	.perch.lift {
		transform: translateY(-7px);
	}

	.branch.sel .twig {
		background: var(--accent);
	}
	.branch.wrong {
		animation: shake 0.3s;
	}
	@keyframes shake {
		25% { transform: translateX(-3px); }
		75% { transform: translateX(3px); }
	}
	@media (prefers-reduced-motion: reduce) {
		.branch.wrong { animation: none; }
	}
</style>

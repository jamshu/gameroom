<script>
	import { Chess } from 'chess.js';
	import Avatar from './Avatar.svelte';
	import { createChessClock, formatClock } from '$lib/chessclock.svelte.js';

	let { store, game, members, myUid } = $props();
	let selected = $state(null); // square like 'e2'
	let error = $state('');
	// own move applied locally before the server confirms — kills the POST+poll lag
	let optimisticFen = $state(null);
	// the server position the optimistic move was played from. A plain `let`, not
	// $state: the effect below writes the overlay, so it must not depend on it.
	let optimisticBaseFen = null;

	/**
	 * Drop the optimistic move once the server position has actually changed.
	 *
	 * This used to be an unconditional `optimisticFen = null`, which read like
	 * "clear when the fen changes" but wasn't: `game` is a read-only rune prop and
	 * Svelte 5 doesn't memoise those, so reading it binds this effect to the
	 * parent's whole store. Every poll — even a chat-only one — wiped the overlay
	 * mid-flight, the piece snapped back, and then the POST response re-applied it.
	 * The effect still re-runs on every poll; comparing against the position we
	 * played from is what stops it. (A repeated position is still a distinct FEN —
	 * the halfmove/fullmove counters advance — so this can't false-negative.)
	 */
	$effect(() => {
		const serverFen = game.fen;
		if (optimisticBaseFen != null && serverFen !== optimisticBaseFen) {
			optimisticBaseFen = null;
			optimisticFen = null;
		}
	});

	const fen = $derived(optimisticFen ?? game.fen);
	const chess = $derived(new Chess(fen));
	const myColor = $derived(game.players.w === myUid ? 'w' : game.players.b === myUid ? 'b' : null);
	const myTurn = $derived(myColor && chess.turn() === myColor && !game.result && !optimisticFen);
	const nameOf = $derived((uid) => members.find((m) => m.uid === uid)?.name || `#${uid}`);

	const FILES = 'abcdefgh';
	// black player sees the board flipped
	const squares = $derived.by(() => {
		const board = chess.board(); // ranks 8..1
		const out = [];
		for (let r = 0; r < 8; r++) {
			for (let f = 0; f < 8; f++) {
				const rr = myColor === 'b' ? 7 - r : r;
				const ff = myColor === 'b' ? 7 - f : f;
				const piece = board[rr][ff];
				out.push({
					sq: FILES[ff] + (8 - rr),
					img: piece ? `/pieces/${piece.color}${piece.type.toUpperCase()}.svg` : null,
					label: piece ? `${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : '',
					dark: (rr + ff) % 2 === 1
				});
			}
		}
		return out;
	});

	const legalTargets = $derived(
		selected ? chess.moves({ square: selected, verbose: true }).map((m) => m.to) : []
	);

	/* ---- clock ------------------------------------------------------------ */

	// Who claims a win on time first. Tiered so the normal case is one request,
	// but a closed opponent tab can't leave the room stuck forever.
	const claimRole = $derived.by(() => {
		if (!myColor) return { spectator: 0 };
		return game.clock?.ticking === myColor ? 'mover' : 'opponent';
	});

	const clock = createChessClock(
		() => ({ v: game.v, clock: game.clock, result: game.result, role: claimRole }),
		() => act('chess/flag')
	);

	async function act(path) {
		try {
			await store.post(path, {});
		} catch (e) {
			error = e.message;
		}
	}

	const lowTime = (ms) => ms != null && ms <= 30000;

	/* ---- fullscreen -------------------------------------------------------- */

	let boardWrap = $state(null);
	// iOS Safari cannot fullscreen arbitrary elements (only <video>), so `isFs`
	// drives a CSS fallback and we only *additionally* use the native API where
	// it works. `nativeFs` is a plain let — it must not drive rendering.
	let isFs = $state(false);
	let nativeFs = false;

	async function toggleFullscreen() {
		if (!isFs) {
			isFs = true; // CSS fallback applies immediately either way
			try {
				if (boardWrap?.requestFullscreen) {
					await boardWrap.requestFullscreen();
					nativeFs = true;
				}
			} catch {
				nativeFs = false; // refused (or iOS) — the CSS fallback still covers us
			}
		} else {
			isFs = false;
			if (nativeFs && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
			nativeFs = false;
		}
	}

	// The browser's own chrome (Esc, F11) can exit native fullscreen without us —
	// keep our flag in sync or the CSS fallback would strand the board full-bleed.
	$effect(() => {
		const sync = () => {
			if (nativeFs && !document.fullscreenElement) {
				nativeFs = false;
				isFs = false;
			}
		};
		document.addEventListener('fullscreenchange', sync);
		return () => document.removeEventListener('fullscreenchange', sync);
	});

	$effect(() => {
		if (!isFs) return;
		const onKey = (e) => {
			if (e.key === 'Escape') isFs = false;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	async function tap(sq) {
		error = '';
		if (!myTurn) return;
		if (selected && legalTargets.includes(sq)) {
			const from = selected;
			selected = null;
			// optimistic: move renders instantly, server confirms via poll
			const local = new Chess(fen);
			try {
				local.move({ from, to: sq, promotion: 'q' });
				optimisticBaseFen = game.fen; // the position the server is still on
				optimisticFen = local.fen();
			} catch {
				return;
			}
			try {
				await store.post('chess/move', { from, to: sq });
			} catch (e) {
				optimisticBaseFen = null; // rollback — server rejected
				optimisticFen = null;
				error = e.message;
			}
			return;
		}
		const piece = chess.get(sq);
		selected = piece && piece.color === myColor ? sq : null;
	}
</script>

<div class="card" style="padding:20px;">
	<div class="chess-head">
		<span class="side">
			<Avatar uid={game.players.w} name={nameOf(game.players.w)} size={24} />
			<img class="mini" src="/pieces/wK.svg" alt="white" />
			<span class="side-name">{nameOf(game.players.w)}</span>
			{#if game.clock}
				<span class="clock" class:clock--live={clock.ticking === 'w'} class:clock--low={lowTime(clock.w)}>
					{formatClock(clock.w)}
				</span>
			{/if}
		</span>
		<span class="side side--right">
			{#if game.clock}
				<span class="clock" class:clock--live={clock.ticking === 'b'} class:clock--low={lowTime(clock.b)}>
					{formatClock(clock.b)}
				</span>
			{/if}
			<span class="side-name">{nameOf(game.players.b)}</span>
			<img class="mini" src="/pieces/bK.svg" alt="black" />
			<Avatar uid={game.players.b} name={nameOf(game.players.b)} size={24} />
		</span>
	</div>

	{#if game.result}
		<p class="chip chip--green" style="margin-bottom:10px;">
			{game.result === 'draw' ? 'Draw!' : `${nameOf(game.players[game.result])} wins! 🏆`}
		</p>
	{:else}
		<p class="muted" style="margin-bottom:10px;">
			{myColor
				? myTurn
					? 'Your move'
					: optimisticFen
						? 'Sending…'
						: `Waiting for ${nameOf(chess.turn() === 'w' ? game.players.w : game.players.b)}…`
				: `Spectating — ${nameOf(chess.turn() === 'w' ? game.players.w : game.players.b)} to move`}
		</p>
	{/if}
	{#if error}<p class="error-text">{error}</p>{/if}

	<div class="board-wrap" class:board-wrap--fs={isFs} bind:this={boardWrap}>
		<div class="board">
			{#each squares as s (s.sq)}
				<button
					class="sq {s.dark ? 'sq--dark' : ''} {selected === s.sq ? 'sq--sel' : ''} {legalTargets.includes(s.sq) ? 'sq--hint' : ''}"
					onclick={() => tap(s.sq)}
				>
					{#if s.img}<img class="piece" src={s.img} alt={s.label} draggable="false" />{/if}
				</button>
			{/each}
		</div>
		<button
			class="btn btn--ghost btn--sm fs-btn"
			onclick={toggleFullscreen}
			title={isFs ? 'Exit fullscreen (Esc)' : 'Fullscreen board'}
		>
			{isFs ? '✕ Exit' : '⛶ Fullscreen'}
		</button>
		{#if isFs}
			<div class="fs-status">
				{#if game.clock}
					<span class="clock" class:clock--live={clock.ticking === 'w'} class:clock--low={lowTime(clock.w)}>
						♔ {formatClock(clock.w)}
					</span>
					<span class="clock" class:clock--live={clock.ticking === 'b'} class:clock--low={lowTime(clock.b)}>
						♚ {formatClock(clock.b)}
					</span>
				{/if}
			</div>
		{/if}
	</div>

	{#if game.moves.length}
		<p class="muted moves">{game.moves.join(' ')}</p>
	{/if}
</div>

<style>
	.chess-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	.side {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.side--right {
		justify-content: flex-end;
	}
	.side-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mini {
		width: 22px;
		height: 22px;
	}
	.clock {
		font-variant-numeric: tabular-nums;
		font-weight: 700;
		font-size: 0.95rem;
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-dim);
	}
	/* the side actually burning time */
	.clock--live {
		color: var(--text);
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}
	.clock--low {
		color: var(--red);
		border-color: color-mix(in srgb, var(--red) 55%, transparent);
		background: color-mix(in srgb, var(--red) 14%, transparent);
	}

	.board-wrap {
		position: relative;
	}
	.board {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		aspect-ratio: 1;
		max-width: 520px;
		border: 2px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.fs-btn {
		margin-top: 10px;
	}

	/* Fullscreen. Also applied as a plain CSS fallback because iOS Safari refuses
	   requestFullscreen on non-<video> elements. The board is normally sized by
	   width alone, so here it has to become height-aware or it overflows. */
	.board-wrap--fs {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		background: var(--bg);
		/* the ancestor's safe-area padding doesn't follow us into the top layer */
		padding: calc(12px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
			calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
	}
	.board-wrap--fs .board {
		max-width: min(100%, calc(100dvh - 130px));
		width: min(100%, calc(100dvh - 130px));
	}
	.board-wrap--fs .fs-btn {
		margin-top: 0;
	}
	.fs-status {
		display: flex;
		gap: 12px;
		order: -1; /* clocks above the board in fullscreen */
	}
	.sq {
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #ebecd0;
		border: none;
		cursor: pointer;
		padding: 0;
	}
	.sq--dark {
		background: #779556;
	}
	.piece {
		width: 88%;
		height: 88%;
		pointer-events: none;
		user-select: none;
	}
	.sq--sel {
		background: #f5f682;
	}
	.sq--dark.sq--sel {
		background: #b9ca43;
	}
	.sq--hint {
		box-shadow: inset 0 0 0 100px rgba(0, 0, 0, 0.14);
	}
	.sq--hint:not(:has(.piece))::after {
		content: '';
		width: 30%;
		height: 30%;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.22);
	}
	.moves {
		margin-top: 10px;
		font-size: 0.8rem;
		word-break: break-word;
	}
</style>

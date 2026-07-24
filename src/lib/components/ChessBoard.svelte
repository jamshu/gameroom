<script>
	import { Chess } from 'chess.js';
	import Avatar from './Avatar.svelte';
	import { createChessClock, formatClock } from '$lib/chessclock.svelte.js';
	import { createFullscreen } from '$lib/fullscreen.svelte.js';

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

	/* ---- move review ------------------------------------------------------ */

	// null = live (a new incoming move keeps a live viewer live automatically);
	// a number is a ply index into `history.fens` we're peeking at.
	let reviewPly = $state(null);

	// Only SAN is persisted, so reconstruct every position (and its from/to) by
	// replaying the move list through a fresh engine. fens[i] = position after i
	// plies; movesAt[i] = the move that produced fens[i] (null at the start).
	const history = $derived.by(() => {
		const c = new Chess();
		const fens = [c.fen()];
		const movesAt = [null];
		for (const san of game.moves) {
			let mv;
			try {
				mv = c.move(san);
			} catch {
				break;
			}
			fens.push(c.fen());
			movesAt.push({ from: mv.from, to: mv.to });
		}
		return { fens, movesAt };
	});
	const liveIdx = $derived(game.moves.length);
	const viewIdx = $derived(reviewPly === null ? liveIdx : reviewPly);
	const reviewFen = $derived(reviewPly === null ? null : history.fens[reviewPly]);
	// the move to tint on the board: the ply being viewed, or the latest one live
	const lastMove = $derived(history.movesAt[Math.min(viewIdx, history.movesAt.length - 1)] || null);

	function reviewFirst() {
		reviewPly = 0;
	}
	function reviewPrev() {
		reviewPly = Math.max(0, viewIdx - 1);
	}
	function reviewNext() {
		const n = viewIdx + 1;
		reviewPly = n >= liveIdx ? null : n;
	}
	function reviewLive() {
		reviewPly = null;
	}

	const fen = $derived(reviewFen ?? optimisticFen ?? game.fen);
	const chess = $derived(new Chess(fen));
	const myColor = $derived(game.players.w === myUid ? 'w' : game.players.b === myUid ? 'b' : null);
	// reviewing is read-only — you can't move while peeking at an old position
	const myTurn = $derived(
		myColor && chess.turn() === myColor && !game.result && !optimisticFen && reviewPly === null
	);
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

	/* ---- resign / draw ---------------------------------------------------- */

	const drawOfferedByMe = $derived(!!game.drawOffer && game.drawOffer === myUid);
	const drawOfferedToMe = $derived(!!game.drawOffer && game.drawOffer !== myUid && !!myColor);

	// why the game ended, for the result chip
	const resultText = $derived.by(() => {
		if (!game.result) return '';
		if (game.result === 'draw')
			return game.endReason === 'draw-agreed' ? 'Draw agreed 🤝' : 'Draw!';
		const winner = nameOf(game.players[game.result]);
		const reason = game.endReason === 'resign' ? ' by resignation' : '';
		return `${winner} wins${reason}! 🏆`;
	});

	async function resign() {
		if (!confirm('Resign this game?')) return;
		await act('chess/resign');
	}
	async function offerDraw() {
		if (!confirm('Offer a draw?')) return;
		try {
			await store.post('chess/draw', { action: 'offer' });
		} catch (e) {
			error = e.message;
		}
	}
	async function respondDraw(action) {
		if (action === 'accept' && !confirm('Accept the draw?')) return;
		try {
			await store.post('chess/draw', { action });
		} catch (e) {
			error = e.message;
		}
	}

	/* ---- fullscreen -------------------------------------------------------- */

	let boardWrap = $state(null);
	const fs = createFullscreen(() => boardWrap);

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
		<p class="chip chip--green" style="margin-bottom:10px;">{resultText}</p>
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

	<div class="board-wrap" class:board-wrap--fs={fs.isFs} bind:this={boardWrap}>
		<div class="board">
			{#each squares as s (s.sq)}
				<button
					class="sq {s.dark ? 'sq--dark' : ''} {selected === s.sq ? 'sq--sel' : ''} {legalTargets.includes(s.sq) ? 'sq--hint' : ''}"
					class:sq--last={lastMove && (lastMove.from === s.sq || lastMove.to === s.sq)}
					onclick={() => tap(s.sq)}
				>
					{#if s.img}<img class="piece" src={s.img} alt={s.label} draggable="false" />{/if}
				</button>
			{/each}
		</div>
		<button
			class="btn btn--ghost btn--sm fs-btn"
			onclick={fs.toggle}
			title={fs.isFs ? 'Exit fullscreen (Esc)' : 'Fullscreen board'}
		>
			{fs.isFs ? '✕ Exit' : '⛶ Fullscreen'}
		</button>
		{#if fs.isFs}
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
		<div class="review">
			<button class="btn btn--ghost btn--sm" onclick={reviewFirst} disabled={viewIdx === 0} title="First move">⏮</button>
			<button class="btn btn--ghost btn--sm" onclick={reviewPrev} disabled={viewIdx === 0} title="Previous move">◀</button>
			<span class="review-pos">
				{#if reviewPly === null}live{:else}move {viewIdx}/{liveIdx}{/if}
			</span>
			<button class="btn btn--ghost btn--sm" onclick={reviewNext} disabled={reviewPly === null} title="Next move">▶</button>
			<button class="btn btn--ghost btn--sm" onclick={reviewLive} disabled={reviewPly === null} title="Back to live">⏭</button>
		</div>
	{/if}

	{#if drawOfferedToMe}
		<div class="draw-offer">
			<span>{nameOf(game.drawOffer)} offers a draw</span>
			<span class="draw-actions">
				<button class="btn btn--sm" onclick={() => respondDraw('accept')}>Accept</button>
				<button class="btn btn--ghost btn--sm" onclick={() => respondDraw('decline')}>Decline</button>
			</span>
		</div>
	{:else if drawOfferedByMe && !game.result}
		<p class="muted" style="margin-top:10px;">Draw offered — waiting for a reply…</p>
	{/if}

	{#if myColor && !game.result}
		<div class="game-actions">
			<button class="btn btn--ghost btn--sm" onclick={offerDraw} disabled={!!game.drawOffer}>½ Offer draw</button>
			<button class="btn btn--ghost btn--sm btn--danger" onclick={resign}>⚑ Resign</button>
		</div>
	{/if}

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

	/* Fullscreen. On mobile this is the ONLY path (native requestFullscreen is
	   gated to desktop in the script) because it's the robust one. The key mobile
	   fix: size by `svh`, the SMALL viewport height — `dvh`/`vh` track the large
	   viewport that includes the space behind the browser's collapsing toolbar, so
	   the board was being sized too tall and clipped/pushed off-screen on phones. */
	.board-wrap--fs {
		position: fixed;
		inset: 0 0 auto 0; /* pin top/left/right; height is explicit below */
		height: 100svh; /* always fully on-screen, never behind mobile chrome */
		z-index: 100;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		background: var(--bg);
		/* the ancestor's safe-area padding doesn't follow us into the top layer.
		   Horizontal padding is kept minimal so the board can go near full-width
		   on phones — width is what caps it in portrait. */
		padding: calc(8px + env(safe-area-inset-top)) calc(4px + env(safe-area-inset-right))
			calc(8px + env(safe-area-inset-bottom)) calc(4px + env(safe-area-inset-left));
	}
	/* clocks + exit button keep their size; the board fits the space that's left */
	.board-wrap--fs .fs-status,
	.board-wrap--fs .fs-btn {
		flex: 0 0 auto;
	}
	.board-wrap--fs .board {
		flex: 0 1 auto;
		/* smaller reserve = bigger board. Just enough for the clocks strip, the
		   exit button, gaps and padding above/below. */
		width: min(100%, calc(100svh - 118px));
		max-width: min(100%, calc(100svh - 118px));
		/* hard guard: never exceed the leftover height even if the reserve is off */
		max-height: calc(100svh - 110px);
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
	/* last move played — tint the from/to squares (both board colours) */
	.sq--last {
		background: #f6eb72;
	}
	.sq--dark.sq--last {
		background: #c9c94a;
	}

	.review {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
	}
	.review-pos {
		font-size: 0.8rem;
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
		min-width: 68px;
		text-align: center;
	}
	.draw-offer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		border: 1px solid var(--accent);
	}
	.draw-actions {
		display: flex;
		gap: 6px;
	}
	.game-actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}
	.moves {
		margin-top: 10px;
		font-size: 0.8rem;
		word-break: break-word;
	}
</style>

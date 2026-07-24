<script>
	import { tick, onMount } from 'svelte';
	import { Chess } from 'chess.js';
	import Avatar from './Avatar.svelte';
	import { playMove, playCapture, isMuted, setMuted, arm } from '$lib/sound.js';
	import { createChessClock, formatClock } from '$lib/chessclock.svelte.js';
	import { createFullscreen, portal } from '$lib/fullscreen.svelte.js';
	import { createChessTheme, BOARD_THEMES, PIECE_SETS } from '$lib/chessthemes.svelte.js';
	import ThemePicker from './ThemePicker.svelte';

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
			movesAt.push({ from: mv.from, to: mv.to, captured: !!mv.captured });
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
					img: piece ? theme.src(piece.color, piece.type) : null,
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

	/* ---- board / piece theme + hover tilt --------------------------------- */

	const theme = createChessTheme();
	let showThemes = $state(false);

	// The tilt writes inline styles straight to the DOM rather than through
	// $state: it fires on every pointermove, and routing 64 squares' worth of
	// that through reactivity would re-render the board on mouse movement.
	const TILT_DEG = 14; // the zoom + lift come from CSS :hover; this is the parallax
	let reduceMotion = false;
	$effect(() => {
		reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	});

	function tiltMove(e) {
		// tilt is a mouse affordance — on touch there is no hover to leave, and a
		// dragged finger would strand a piece mid-tilt
		if (reduceMotion || e.pointerType !== 'mouse') return;
		const el = e.currentTarget;
		const lift = el.querySelector('.lift');
		if (!lift) return; // empty square — nothing to tilt
		const r = el.getBoundingClientRect();
		const px = (e.clientX - r.left) / r.width - 0.5;
		const py = (e.clientY - r.top) / r.height - 0.5;
		lift.style.transition = 'transform .06s linear';
		lift.style.transform = `rotateX(${(-py * TILT_DEG).toFixed(2)}deg) rotateY(${(px * TILT_DEG).toFixed(2)}deg)`;
		const shadow = el.querySelector('.contact');
		if (shadow) {
			shadow.style.transform = `translateX(calc(-50% + ${(-px * 14).toFixed(1)}px)) translateY(${(-py * 5).toFixed(1)}px) scale(${(1 - Math.abs(px) * 0.14).toFixed(3)})`;
		}
		const sheen = el.querySelector('.sheen');
		if (sheen) {
			sheen.style.opacity = '1';
			sheen.style.background = `radial-gradient(circle at ${((px + 0.5) * 100).toFixed(0)}% ${((py + 0.5) * 100).toFixed(0)}%, rgba(255,255,255,.6), rgba(255,255,255,0) 58%)`;
		}
	}

	function tiltLeave(e) {
		const el = e.currentTarget;
		const lift = el.querySelector('.lift');
		if (lift) {
			lift.style.transition = 'transform .55s cubic-bezier(.22,.61,.36,1)';
			lift.style.transform = 'rotateX(0deg) rotateY(0deg)';
		}
		const shadow = el.querySelector('.contact');
		if (shadow) shadow.style.transform = 'translateX(-50%) translateY(0) scale(1)';
		const sheen = el.querySelector('.sheen');
		if (sheen) sheen.style.opacity = '0';
	}

	/* ---- piece movement animation ----------------------------------------- */

	// Pieces are rendered from the FEN, so a move would otherwise teleport. After
	// the DOM settles we measure the from/to squares and play the piece in from
	// its old position (a FLIP): no per-piece identity tracking needed, which
	// castling, captures and promotions would all complicate.
	let boardEl = $state(null);
	const SLIDE_MS = 210;

	function slide(from, to) {
		if (reduceMotion || !boardEl) return;
		const a = boardEl.querySelector(`[data-sq="${from}"]`);
		const b = boardEl.querySelector(`[data-sq="${to}"]`);
		const mover = b?.querySelector('.lift');
		if (!a || !b || !mover) return;
		const ra = a.getBoundingClientRect();
		const rb = b.getBoundingClientRect();
		const dx = ra.left - rb.left;
		const dy = ra.top - rb.top;
		if (!dx && !dy) return;
		mover.animate(
			[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
			{ duration: SLIDE_MS, easing: 'cubic-bezier(.22,.61,.36,1)' }
		);
		// the captured/landing square gets a brief pop
		const img = mover.querySelector('.piece');
		if (img) {
			img.animate(
				[{ filter: 'brightness(1.35)' }, { filter: 'brightness(1)' }],
				{ duration: SLIDE_MS + 120, easing: 'ease-out' }
			);
		}
	}

	/** A piece landing, or a heavier thwack when it takes something. */
	function playMoveSound(mv) {
		if (mv?.captured) playCapture();
		else playMove();
	}

	// My own move renders optimistically, so it is animated and sounded the moment
	// it is played; remember it so the server echo doesn't replay either.
	let selfAnimated = null; // plain let — must not drive rendering
	let seenPly = null;

	$effect(() => {
		const n = game.moves.length;
		const mv = history.movesAt[Math.min(n, history.movesAt.length - 1)] || null;
		if (seenPly === null || n < seenPly) {
			seenPly = n; // first render, or a rematch reset — nothing to play in
			return;
		}
		if (n === seenPly) return;
		seenPly = n;
		if (reviewPly !== null) return; // reviewing an old position
		if (selfAnimated && mv && selfAnimated.from === mv.from && selfAnimated.to === mv.to) {
			selfAnimated = null; // already slid + sounded locally when I played it
			return;
		}
		if (mv) {
			slide(mv.from, mv.to);
			// state-driven, so spectators and the waiting player hear it too
			playMoveSound(mv);
		}
	});

	/* ---- sound ------------------------------------------------------------ */

	let muted = $state(false);
	onMount(() => {
		muted = isMuted();
		arm(); // bind the autoplay unlock now, or the first move would be silent
	});
	function toggleMute() {
		muted = !muted;
		setMuted(muted);
	}

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

	// Fullscreen clocks sit on each player's own side: my clock at the bottom (the
	// board already flips so my pieces are at the bottom), the opponent's at the
	// top. Spectators get the standard white-bottom / black-top orientation.
	const bottomColor = $derived(myColor || 'w');
	const topColor = $derived(bottomColor === 'w' ? 'b' : 'w');
	const kingGlyph = (c) => (c === 'w' ? '♔' : '♚');

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
			let played;
			try {
				played = local.move({ from, to: sq, promotion: 'q' });
				optimisticBaseFen = game.fen; // the position the server is still on
				optimisticFen = local.fen();
			} catch {
				return;
			}
			// play the piece across as soon as it has rendered on its new square
			selfAnimated = { from, to: sq };
			tick().then(() => slide(from, sq));
			playMoveSound({ captured: !!played.captured });
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
	<!-- each player on their own side: opponent bar above the board, my bar below -->
	{#snippet playerBar(color)}
		<div class="chess-player">
			<Avatar uid={game.players[color]} name={nameOf(game.players[color])} size={28} />
			<img class="mini" src={theme.src(color, 'K')} alt={color === 'w' ? 'white' : 'black'} />
			<span class="side-name">{nameOf(game.players[color])}</span>
			{#if game.clock}
				<span class="clock" class:clock--live={clock.ticking === color} class:clock--low={lowTime(clock[color])}>
					{formatClock(clock[color])}
				</span>
			{/if}
		</div>
	{/snippet}

	{@render playerBar(topColor)}

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

	<div class="board-wrap" class:board-wrap--fs={fs.isFs} bind:this={boardWrap} use:portal={fs.isFs}>
		<div class="board" style={theme.style} bind:this={boardEl}>
			{#each squares as s (s.sq)}
				<button
					class="sq {s.dark ? 'sq--dark' : ''} {selected === s.sq ? 'sq--sel' : ''} {legalTargets.includes(s.sq) ? 'sq--hint' : ''}"
					class:sq--last={lastMove && (lastMove.from === s.sq || lastMove.to === s.sq)}
					class:sq--occupied={!!s.img}
					data-sq={s.sq}
					onclick={() => tap(s.sq)}
					onpointermove={tiltMove}
					onpointerleave={tiltLeave}
				>
					{#if s.img}
						<span class="glow"></span>
						<span class="contact"></span>
						<span class="lift">
							<img class="piece" src={s.img} alt={s.label} draggable="false" />
							<span class="sheen"></span>
						</span>
					{/if}
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
		{#if fs.isFs && game.clock}
			<div class="fs-player fs-player--top">
				<span class="side-name">{nameOf(game.players[topColor])}</span>
				<span class="clock" class:clock--live={clock.ticking === topColor} class:clock--low={lowTime(clock[topColor])}>
					{kingGlyph(topColor)} {formatClock(clock[topColor])}
				</span>
			</div>
			<div class="fs-player fs-player--bottom">
				<span class="side-name">{nameOf(game.players[bottomColor])}</span>
				<span class="clock" class:clock--live={clock.ticking === bottomColor} class:clock--low={lowTime(clock[bottomColor])}>
					{kingGlyph(bottomColor)} {formatClock(clock[bottomColor])}
				</span>
			</div>
		{/if}
	</div>

	{@render playerBar(bottomColor)}

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

	<div class="game-actions">
		{#if myColor && !game.result}
			<button class="btn btn--ghost btn--sm" onclick={offerDraw} disabled={!!game.drawOffer}>½ Offer draw</button>
			<button class="btn btn--ghost btn--sm btn--danger" onclick={resign}>⚑ Resign</button>
		{/if}
		<button
			class="btn btn--ghost btn--sm"
			onclick={() => (showThemes = !showThemes)}
			aria-expanded={showThemes}
		>
			🎨 Theme
		</button>
		<button
			class="btn btn--ghost btn--sm"
			onclick={toggleMute}
			aria-label={muted ? 'Turn move sounds on' : 'Turn move sounds off'}
			title={muted ? 'Move sounds off' : 'Move sounds on'}
		>
			{muted ? '🔇' : '🔊'}
		</button>
	</div>

	{#if showThemes}
		<ThemePicker
			groups={[
				{
					label: 'Board',
					selected: theme.board,
					onselect: (id) => theme.setBoard(id),
					options: BOARD_THEMES.map((t) => ({
						id: t.id,
						label: t.label,
						swatch: { colors: [t.light, t.dark] }
					}))
				},
				{
					label: 'Pieces',
					selected: theme.pieces,
					onselect: (id) => theme.setPieces(id),
					options: PIECE_SETS.map((p) => ({
						id: p.id,
						label: p.label,
						swatch: { img: `/pieces/${p.id}/wN.svg` }
					}))
				}
			]}
		/>
	{/if}

	{#if game.moves.length}
		<p class="muted moves">{game.moves.join(' ')}</p>
	{/if}
</div>

<style>
	/* a player row: avatar + colour + name on the left, clock on the right */
	.chess-player {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		margin-block: 8px;
	}
	.chess-player .clock {
		margin-left: auto; /* push the clock to the right edge of the row */
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
		inset: 0; /* fill the real viewport exactly, so centring is true centre.
		             (height:100svh resolved TALLER than the viewport and pushed the
		             board below centre — the "blank space at top" bug.) */
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
	/* chess.com layout: each player's clock on their own side — opponent pinned to
	   the top, me to the bottom — with ONLY the board centred in between, so it
	   sits dead centre with no floating gap. */
	.board-wrap--fs .fs-player {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: 70%;
	}
	/* opponent strip spans the top (name left, clock right) */
	.board-wrap--fs .fs-player--top {
		top: calc(8px + env(safe-area-inset-top));
		left: 12px;
		right: 12px;
		max-width: none;
		justify-content: space-between;
	}
	/* my strip sits bottom-left; the exit button takes the bottom-right */
	.board-wrap--fs .fs-player--bottom {
		bottom: calc(8px + env(safe-area-inset-bottom));
		left: 12px;
	}
	.board-wrap--fs .fs-player .side-name {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.board-wrap--fs .fs-btn {
		position: absolute;
		bottom: calc(8px + env(safe-area-inset-bottom));
		right: calc(8px + env(safe-area-inset-right));
		left: auto;
		transform: none;
		margin: 0;
	}
	.board-wrap--fs .board {
		flex: 0 1 auto;
		/* reserve keeps the centred board clear of the pinned clock strips */
		width: min(100%, calc(100svh - 108px));
		max-width: min(100%, calc(100svh - 108px));
		max-height: calc(100svh - 108px);
	}
	/* square colours come from the chosen board theme (--sq-l / --sq-d, set on
	   .board), with a fallback so the board is never unstyled */
	.sq {
		position: relative;
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--sq-l, #ebecd0);
		border: none;
		cursor: pointer;
		padding: 0;
		perspective: 460px; /* gives the hover tilt its depth */
	}
	.sq--dark {
		background: var(--sq-d, #779556);
	}
	/* hover tilt layers — see tiltMove()/tiltLeave() in the script */
	.lift {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		transform-style: preserve-3d;
		will-change: transform;
		pointer-events: none;
	}
	.contact {
		position: absolute;
		left: 50%;
		bottom: 6%;
		width: 56%;
		height: 9%;
		transform: translateX(-50%);
		pointer-events: none;
		filter: blur(2px);
		background: radial-gradient(closest-side, rgba(0, 0, 0, 0.5), transparent);
		transition:
			transform 0.5s cubic-bezier(0.22, 0.61, 0.36, 1),
			opacity 0.2s ease,
			width 0.2s ease;
	}
	.sheen {
		position: absolute;
		inset: 16% 22%;
		border-radius: 50%;
		opacity: 0;
		mix-blend-mode: screen;
		pointer-events: none;
		transition: opacity 0.25s;
	}
	/* soft pool of light under the cursor's piece */
	.glow {
		position: absolute;
		inset: 0;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.25s ease;
		background: radial-gradient(circle at 50% 42%, rgba(255, 255, 255, 0.5), transparent 68%);
	}
	.piece {
		width: 95%;
		height: 95%;
		pointer-events: none;
		user-select: none;
		transform: translateZ(14px); /* lifts the piece off the square for parallax */
		filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.34));
		transition:
			transform 0.22s cubic-bezier(0.22, 0.61, 0.36, 1),
			filter 0.22s ease;
	}

	/* Hover: the piece zooms and lifts off the board, its shadow drops away and
	   widens as if it rose. Mouse only — a touch device has no hover to leave. */
	@media (hover: hover) and (pointer: fine) {
		.sq--occupied:hover {
			z-index: 3; /* the zoomed piece overlaps its neighbours */
		}
		.sq--occupied:hover .piece {
			transform: translateZ(42px) scale(1.22);
			filter: drop-shadow(0 14px 18px rgba(0, 0, 0, 0.5)) drop-shadow(0 3px 4px rgba(0, 0, 0, 0.3));
		}
		.sq--occupied:hover .glow {
			opacity: 1;
		}
		.sq--occupied:hover .contact {
			opacity: 0.45;
			width: 66%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.piece,
		.contact,
		.glow,
		.sheen {
			transition: none;
		}
		.sq--occupied:hover .piece {
			transform: translateZ(14px) scale(1.08);
		}
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
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}

	/* theme picker styling lives in ThemePicker.svelte, shared by all boards */
	.moves {
		margin-top: 10px;
		font-size: 0.8rem;
		word-break: break-word;
	}
</style>

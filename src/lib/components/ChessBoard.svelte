<script>
	import { tick, onMount, onDestroy } from 'svelte';
	import { Chess } from 'chess.js';
	import Avatar from './Avatar.svelte';
	import { playMove, playCapture, isMuted, setMuted, arm } from '$lib/sound.js';
	import { createChessClock, formatClock } from '$lib/chessclock.svelte.js';
	import { createFullscreen, portal } from '$lib/fullscreen.svelte.js';
	import { createChessTheme, BOARD_THEMES, PIECE_SETS } from '$lib/chessthemes.svelte.js';
	import { createChessEngine } from '$lib/chessengine.svelte.js';
	import ThemePicker from './ThemePicker.svelte';

	let { store, game, members, myUid, isPremium = false } = $props();
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
			clearOverlay();
		}
	});

	/**
	 * How long to hold an optimistic move whose POST never answered.
	 *
	 * A timeout tells us nothing about whether the server applied the move, so
	 * dropping the overlay immediately was a coin flip that lost loudly: the piece
	 * snapped back and then jumped forward again seconds later. Holding it instead
	 * makes the common case (it landed) invisible — the effect above clears the
	 * overlay the moment the server position moves off the one we played from.
	 *
	 * But it MUST be bounded: `myTurn` is gated on `!optimisticFen`, so an overlay
	 * that never clears locks the player out of retrying their own move. Sized past
	 * the store's reconcile poll (~1.2s) plus a slow Odoo round trip, so the answer
	 * has had every chance to arrive before we give up on it.
	 */
	const OFFLINE_HOLD_MS = 8000;
	let offlineHoldTimer = null;

	function clearOverlay() {
		clearTimeout(offlineHoldTimer);
		offlineHoldTimer = null;
		optimisticBaseFen = null;
		optimisticFen = null;
	}

	onDestroy(() => clearTimeout(offlineHoldTimer));

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

	/* ---- engine hint (premium) --------------------------------------------- */

	/**
	 * "What's the best move here?" — advisory only. It never plays anything: the
	 * suggestion is a highlight plus a SAN label, and the player is free to ignore
	 * it and move wherever they like.
	 *
	 * Deliberately NOT gated on `myTurn`. It analyses whatever position is on
	 * screen, which is what makes "what is my opponent's best reply?" and "what
	 * should I have played ten moves ago?" work — the latter for free, because
	 * `fen` already resolves review and optimistic precedence.
	 *
	 * The gate is `isPremium`, and it is presentational: the engine runs in this
	 * browser, so there is no request for the server to refuse. See the premium
	 * flag's own comments in src/lib/server/premium.js.
	 */
	// Created unconditionally — this allocates nothing but closures. The Worker and
	// the ~656 KB of WASM behind it are not fetched until `analyse` is first called,
	// and the only path there is a button that renders for premium users only. That
	// also keeps `isPremium` reactive: a flag that resolves after mount (the session
	// check is async) still gets a working button rather than a dead one.
	const engine = createChessEngine();
	// { fen, from, to, san } for a real suggestion, or { fen, san: null } when the
	// position has no move at all. It always carries the fen it answers, which is
	// what the staleness check below keys on.
	let hint = $state(null);

	onDestroy(() => engine.dispose());

	// A hint is only meaningful for the position it was computed for. Searches take
	// ~a second and this button works on the opponent's turn, so an incoming move
	// lands mid-search routinely; so does stepping through history. Same guard the
	// optimistic overlay makes against `optimisticBaseFen` further up.
	$effect(() => {
		if (hint && hint.fen !== fen) hint = null;
	});

	async function askHint() {
		if (engine.busy) return;
		const asked = fen;
		error = '';
		hint = null;
		try {
			const best = await engine.analyse(asked);
			// Superseded while we waited — the board has moved on, so drop it rather
			// than highlight squares the move is no longer legal on.
			if (asked !== fen) return;
			hint = best || { fen: asked, san: null };
		} catch (e) {
			error = e?.message || 'Could not reach the engine';
		}
	}

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

	// Authoritative state moved on, so whatever a failed post complained about is
	// now answered. Matters most for a dropped connection: api() can't tell whether
	// the server got the move, so it warns — and if it did land, that warning would
	// otherwise sit over an already-correct board until the next action.
	let clearedAtV = null;
	$effect(() => {
		const v = game.v;
		if (v !== clearedAtV) {
			clearedAtV = v;
			error = '';
		}
	});

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
				if (e?.offline) {
					// The response never arrived, so the move may well have landed.
					// Keep it on the board ("Sending…") and let the store's reconcile
					// poll settle it; roll back only if nothing has answered by then.
					//
					// The complaint goes in the TIMER, not here: raising it now would
					// warn about a move that is probably fine, and staying silent
					// when the timer fires would snap the piece back with no
					// explanation at all — worse than the banner it replaced. If the
					// move did land, the $effect above clears this timer first, so
					// the message is never shown. If it didn't, `game.v` hasn't moved
					// either, so the clearedAtV effect won't wipe it.
					clearTimeout(offlineHoldTimer);
					offlineHoldTimer = setTimeout(() => {
						clearOverlay();
						error = e.message;
					}, OFFLINE_HOLD_MS);
				} else {
					clearOverlay(); // the server actually rejected it
					error = e.message;
				}
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

	<!-- Everything below is a snippet so it can render EITHER in the card or inside
	     the portaled .board-wrap, never both. Fullscreen moves .board-wrap to <body>
	     and covers the card with an opaque overlay, so a second copy would not just
	     be untidy — it would still be reachable by keyboard behind the overlay. -->
	{#snippet statusLine()}
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
	{/snippet}

	{#snippet reviewBar()}
		{#if game.moves.length}
			<div class="review">
				<button class="btn btn--ghost btn--sm" onclick={reviewFirst} disabled={viewIdx === 0} title="First move">⏮</button>
				<button class="btn btn--ghost btn--sm" onclick={reviewPrev} disabled={viewIdx === 0} title="Previous move">◀</button>
				<span class="review-pos">
					{#if reviewPly === null}live{:else}move {viewIdx}/{liveIdx}{/if}
				</span>
				<button class="btn btn--ghost btn--sm" onclick={reviewNext} disabled={reviewPly === null} title="Next move">▶</button>
				<!-- not optional: myTurn is gated on reviewPly === null, so without a way
				     back to live a reviewing player cannot move at all -->
				<button class="btn btn--ghost btn--sm" onclick={reviewLive} disabled={reviewPly === null} title="Back to live">⏭</button>
			</div>
		{/if}
	{/snippet}

	{#snippet hintBar()}
		<!-- Deliberately still offered after the game has a result: the review bar
		     outlives the game too, and "what should I have played?" on a game you
		     just lost is the most useful thing the engine does. Terminal positions
		     answer "No moves here" rather than hanging. -->
		{#if isPremium}
			<div class="hint">
				<button class="btn btn--ghost btn--sm" onclick={askHint} disabled={engine.busy}>
					{engine.busy ? '💡 Thinking…' : '💡 Best move'}
				</button>
				{#if hint}
					<span class="hint-san">
						{#if hint.san}Best: <b>{hint.san}</b>{:else}No moves here{/if}
					</span>
				{/if}
			</div>
		{/if}
	{/snippet}

	{#snippet drawOfferBlock()}
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
	{/snippet}

	{#snippet matchActions()}
		{#if myColor && !game.result}
			<button class="btn btn--ghost btn--sm" onclick={offerDraw} disabled={!!game.drawOffer}>½ Offer draw</button>
			<button class="btn btn--ghost btn--sm btn--danger" onclick={resign}>⚑ Resign</button>
		{/if}
	{/snippet}

	{#if !fs.isFs}{@render statusLine()}{/if}

	<div class="board-wrap" class:board-wrap--fs={fs.isFs} bind:this={boardWrap} use:portal={fs.isFs}>
		<div class="board" style={theme.style} bind:this={boardEl}>
			{#each squares as s (s.sq)}
				<button
					class="sq {s.dark ? 'sq--dark' : ''} {selected === s.sq ? 'sq--sel' : ''} {legalTargets.includes(s.sq) ? 'sq--hint' : ''}"
					class:sq--last={lastMove && (lastMove.from === s.sq || lastMove.to === s.sq)}
					class:sq--best={hint?.san && (hint.from === s.sq || hint.to === s.sq)}
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
		{#if fs.isFs}
			<!-- All absolutely positioned. The board is dead-centre only because it is
			     the SOLE in-flow child of this flex column; an in-flow row here would
			     shift it and break the centring assertion in chess-fullscreen.spec.js. -->
			<div class="fs-status">{@render statusLine()}</div>
			<div class="fs-draw">{@render drawOfferBlock()}</div>
			<div class="fs-controls">
				{@render reviewBar()}
				{@render hintBar()}
				{@render matchActions()}
			</div>
		{/if}
	</div>

	{@render playerBar(bottomColor)}

	{#if !fs.isFs}
		{@render reviewBar()}
		{@render hintBar()}
		{@render drawOfferBlock()}
	{/if}

	<div class="game-actions">
		<!-- Theme and mute deliberately stay card-only; they are not match controls
		     and the fullscreen overlay has no room to spare. -->
		{#if !fs.isFs}{@render matchActions()}{/if}
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
		/* the room page raises this while a game is on and chat is hidden; the
		   fallback is the lobby/standalone size. Squares and pieces are sized in
		   %, so the board just scales. */
		max-width: var(--board-cap, 520px);
		/* Premium framed board: a dark inner edge, an outer ring, a lift shadow.
		   Tones derived from theme vars so it suits any board palette. */
		border: 3px solid color-mix(in srgb, var(--border) 55%, #000);
		border-radius: var(--radius-sm);
		box-shadow:
			0 0 0 3px color-mix(in srgb, var(--surface-2) 88%, #000),
			0 0 0 4px color-mix(in srgb, #fff 8%, transparent),
			var(--shadow-lg);
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
		overflow: hidden;
		background: var(--bg);
		/* the ancestor's safe-area padding doesn't follow us into the top layer.
		   Zero horizontal padding (only the notch inset) so the board reaches the
		   true screen edges like chess.com — width is what caps it in portrait. */
		/* The two bands are DELIBERATELY unequal, and the padding is how the board
		   gets pushed up off the bottom one.

		   The bottom has to hold two things — the clock strip (8..36) and the
		   review/match controls above it (46..~82) — while the top holds the clock
		   strip and a one-line status (40..~60). Splitting the reserve evenly, which
		   is what plain centring does, gave both 74px and the buttons sat 12px INTO
		   the bottom rank of pieces on every height-bound viewport.

		   Padding works here precisely because it does not move the controls: an
		   absolutely positioned child anchors to the PADDING box, which padding does
		   not shift, while the in-flow board centres inside the CONTENT box. So the
		   board rises and everything pinned to an edge stays put. */
		--fs-top: 78px;
		--fs-bottom: 112px;
		--fs-reserve: calc(var(--fs-top) + var(--fs-bottom));
		padding: calc(var(--fs-top) + env(safe-area-inset-top)) env(safe-area-inset-right)
			calc(var(--fs-bottom) + env(safe-area-inset-bottom)) env(safe-area-inset-left);
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
	/* Below ~560px the controls cannot fit ⏮◀▶⏭ plus Offer draw plus Resign on one
	   line and wrap to two, so the bottom band has to be deeper. Narrow screens are
	   overwhelmingly tall ones, where the board is width-bound and a bigger reserve
	   costs nothing; it only bites on a narrow AND short window, which is exactly
	   the case that was overlapping. */
	@media (max-width: 560px) {
		.board-wrap--fs {
			--fs-bottom: 158px;
		}
	}
	/* Status sits under the top clock strip; controls sit above the bottom one.
	   Out of flow, so they anchor to the padding box and the board's asymmetric
	   padding lifts it clear of them without dragging them along. */
	.board-wrap--fs .fs-status {
		position: absolute;
		top: calc(40px + env(safe-area-inset-top));
		left: 12px;
		right: 12px;
		text-align: center;
	}
	/* the snippets carry their own bottom margins for the card layout — pointless
	   here and they push the text off-centre in the band */
	.board-wrap--fs .fs-status :global(p) {
		margin: 0;
	}
	.board-wrap--fs .fs-controls {
		position: absolute;
		bottom: calc(46px + env(safe-area-inset-bottom));
		left: 8px;
		right: 8px;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}
	.board-wrap--fs .fs-controls :global(.review),
	.board-wrap--fs .fs-controls :global(.hint) {
		margin-top: 0;
	}
	/* A draw offer is a question that needs answering, so it goes centre-screen over
	   the board rather than into a corner. */
	.board-wrap--fs .fs-draw {
		position: absolute;
		left: 12px;
		right: 12px;
		bottom: calc(50% - 24px);
	}
	.board-wrap--fs .fs-draw :global(.draw-offer),
	.board-wrap--fs .fs-draw :global(p) {
		margin: 0;
		justify-content: center;
		text-align: center;
		box-shadow: var(--shadow-lg);
	}
	.board-wrap--fs .board {
		flex: 0 1 auto;
		/* fill the viewport edge-to-edge; --fs-reserve keeps the board clear of the
		   pinned clock strips. On a tall phone width wins → board = full 100vw. */
		width: min(100%, calc(100svh - var(--fs-reserve)));
		max-width: min(100%, calc(100svh - var(--fs-reserve)));
		max-height: calc(100svh - var(--fs-reserve));
		border: none;
		border-radius: 0;
	}
	/* square colours come from the chosen board theme (--sq-l / --sq-d, set on
	   .board), with a fallback so the board is never unstyled */
	.sq {
		position: relative;
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		/* faint top-lit gradient off the theme colour for gentle depth — no radius,
		   squares still tile as one continuous surface */
		background: linear-gradient(
			160deg,
			color-mix(in srgb, var(--sq-l, #ebecd0) 90%, #fff),
			var(--sq-l, #ebecd0)
		);
		border: none;
		cursor: pointer;
		padding: 0;
		perspective: 460px; /* gives the hover tilt its depth */
	}
	.sq--dark {
		background: linear-gradient(
			160deg,
			color-mix(in srgb, var(--sq-d, #779556) 88%, #fff),
			color-mix(in srgb, var(--sq-d, #779556) 97%, #000)
		);
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
		/* glossy specular that appears as the piece lifts on hover */
		background: radial-gradient(circle at 42% 30%, rgba(255, 255, 255, 0.6), transparent 62%);
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
		/* 110% so the glyph (SVGs carry transparent padding) fills the square edge-
		   to-edge like chess.com; overflow is transparent, centred by .lift */
		width: 110%;
		height: 110%;
		pointer-events: none;
		user-select: none;
		transform: translateZ(14px); /* lifts the piece off the square for parallax */
		filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.34)) drop-shadow(0 0 1px rgba(0, 0, 0, 0.55));
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
		.sq--occupied:hover .sheen {
			opacity: 0.85;
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
			transform: translateZ(14px) scale(1.12);
		}
	}
	/* Highlights sit OVER the theme square colour (glassy) rather than replacing it,
	   so the board palette always shows through. */
	.sq--sel {
		box-shadow: inset 0 0 0 4px color-mix(in srgb, var(--accent) 88%, #fff);
	}
	/* last move played — soft warm wash over the from/to squares */
	.sq--last {
		box-shadow: inset 0 0 0 100px color-mix(in srgb, var(--accent-2, #ffcc33) 22%, transparent);
	}
	/* selection wins over last-move when both land on one square */
	.sq--last.sq--sel {
		box-shadow:
			inset 0 0 0 100px color-mix(in srgb, var(--accent-2, #ffcc33) 18%, transparent),
			inset 0 0 0 4px color-mix(in srgb, var(--accent) 88%, #fff);
	}
	/* engine suggestion — deliberately green, so it reads as "advice" and never
	   collides with the accent (selection/legal moves) or accent-2 (last move) */
	.sq--best {
		box-shadow:
			inset 0 0 0 100px color-mix(in srgb, #22c55e 20%, transparent),
			inset 0 0 0 4px color-mix(in srgb, #22c55e 80%, #fff);
	}
	/* your own selection still wins — you are the one moving, the engine only advises */
	.sq--best.sq--sel {
		box-shadow:
			inset 0 0 0 100px color-mix(in srgb, #22c55e 20%, transparent),
			inset 0 0 0 4px color-mix(in srgb, var(--accent) 88%, #fff);
	}
	/* legal move onto an empty square — a tidy accent dot */
	.sq--hint:not(:has(.piece))::after {
		content: '';
		width: 30%;
		height: 30%;
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 55%, rgba(0, 0, 0, 0.45));
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
	}
	/* legal capture — a ring hugging the target piece (chess.com style) */
	.sq--hint.sq--occupied {
		box-shadow: inset 0 0 0 6px color-mix(in srgb, var(--accent) 45%, transparent);
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
	.hint {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
	}
	.hint-san {
		font-size: 0.8rem;
		color: var(--text-dim);
	}
	.hint-san b {
		color: #22c55e; /* matches the board highlight */
		font-variant-numeric: tabular-nums;
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

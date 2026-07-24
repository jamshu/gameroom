<script>
	import { onMount } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { playDice, playCapture, playHome, playMove, playPass, isMuted, setMuted, arm } from '$lib/sound.js';
	import { createFullscreen, portal } from '$lib/fullscreen.svelte.js';
	import { createTheme, LUDO_THEMES } from '$lib/themes.svelte.js';
	import ThemePicker from './ThemePicker.svelte';

	let { store, game, members, myUid } = $props();
	let error = $state('');
	let posting = $state(false);

	// Re-maps what red/green/yellow/blue look like; seat identity is the server's.
	const theme = createTheme({ key: 'gameroom:ludo-theme', themes: LUDO_THEMES });
	let showThemes = $state(false);

	let playArea = $state(null);
	const fs = createFullscreen(() => playArea);
	let rolling = $state(false);
	let muted = $state(false);
	// 3D die: the value comes from the player's swipe (see swipeEnd). cubeRX/cubeRY
	// drive the cube's orientation; baseX/baseY accumulate whole spins so each
	// throw tumbles forward before settling on the swiped face.
	let shownValue = $state(1);
	let cubeRX = $state(-24);
	let cubeRY = $state(18);
	let baseX = 0;
	let baseY = 0;
	let swipe = null; // { x, y } captured on pointerdown

	const nameOf = $derived((uid) => members.find((m) => m.uid === Number(uid))?.name || `#${uid}`);
	const currentUid = $derived(game.players[game.turnIdx]);
	const isMine = $derived(currentUid === myUid);
	const myTurn = $derived(isMine && !game.result && !posting);
	const myColor = $derived(game.colors?.[myUid]);

	/* ---- board geometry (15×15 grid) ------------------------------------
	   pos encoding matches the server: -1 yard, 0..50 shared ring (relative to
	   the player's start), 51..55 home lane, 56 = home/finished. */
	const N = 15;
	const START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
	// The 52 shared ring cells as [row, col]; index 0 = red start, 13 = green,
	// 26 = yellow, 39 = blue (matches START_OFFSET).
	const TRACK = [
		[6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
		[5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
		[0, 7], [0, 8],
		[1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
		[6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
		[7, 14], [8, 14],
		[8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
		[9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
		[14, 7], [14, 6],
		[13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
		[8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
		[7, 0], [6, 0]
	];
	const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
	const START_COLOR = { 0: 'red', 13: 'green', 26: 'yellow', 39: 'blue' };
	const HOME_LANES = {
		red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
		green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
		yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
		blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]]
	};
	// yard token slots (centres in grid units) + finished-token centre per colour
	const YARD_SPOTS = {
		red: [[1.6, 1.6], [1.6, 3.9], [3.9, 1.6], [3.9, 3.9]],
		green: [[1.6, 10.6], [1.6, 12.9], [3.9, 10.6], [3.9, 12.9]],
		yellow: [[10.6, 10.6], [10.6, 12.9], [12.9, 10.6], [12.9, 12.9]],
		blue: [[10.6, 1.6], [10.6, 3.9], [12.9, 1.6], [12.9, 3.9]]
	};
	const CENTER_SPOT = { red: [7.5, 6.75], green: [6.75, 7.5], yellow: [7.5, 8.25], blue: [8.25, 7.5] };

	function yardColorAt(r, c) {
		if (r < 6 && c < 6) return 'red';
		if (r < 6 && c > 8) return 'green';
		if (r > 8 && c < 6) return 'blue';
		if (r > 8 && c > 8) return 'yellow';
		return null;
	}
	function centerColorAt(r, c) {
		const rr = r - 7, cc = c - 7;
		if (rr === 0 && cc === 0) return null; // dead centre
		if (Math.abs(rr) >= Math.abs(cc)) return rr < 0 ? 'green' : 'blue';
		return cc < 0 ? 'red' : 'yellow';
	}

	// per-cell meta, computed once (constant board)
	const cellMeta = new Map();
	TRACK.forEach(([r, c], i) => cellMeta.set(r * N + c, { kind: 'track', safe: SAFE.has(i), color: START_COLOR[i] || null }));
	for (const [color, cells] of Object.entries(HOME_LANES)) cells.forEach(([r, c]) => cellMeta.set(r * N + c, { kind: 'home', color }));
	function metaAt(r, c) {
		const m = cellMeta.get(r * N + c);
		if (m) return m;
		const y = yardColorAt(r, c);
		if (y) return { kind: 'yard', color: y };
		if (r >= 6 && r <= 8 && c >= 6 && c <= 8) return { kind: 'center', color: centerColorAt(r, c) };
		return { kind: 'gap', color: null };
	}
	const cells = Array.from({ length: N * N }, (_, k) => {
		const r = Math.floor(k / N), c = k % N;
		return { r, c, ...metaAt(r, c) };
	});

	// token → centre [row,col] in grid units for its current pos
	function tokenCentre(uid, i) {
		const color = game.colors[uid];
		const pos = game.tokens[uid][i];
		if (pos === -1) return YARD_SPOTS[color][i];
		if (pos <= 50) { const [r, c] = TRACK[(START_OFFSET[color] + pos) % 52]; return [r + 0.5, c + 0.5]; }
		if (pos <= 55) { const [r, c] = HOME_LANES[color][pos - 51]; return [r + 0.5, c + 0.5]; }
		return CENTER_SPOT[color]; // finished
	}
	const pct = (v) => `${(v / N) * 100}%`;

	// which of MY tokens can move with the pending dice (client mirror of the
	// server rule — for highlighting; the server stays the source of truth).
	function legalTokens(uid, dice) {
		const toks = game.tokens[uid] || [];
		const out = [];
		for (let i = 0; i < toks.length; i++) {
			const p = toks[i];
			if (p === 56) continue;
			if (p === -1) { if (dice === 6) out.push(i); continue; }
			if (p + dice <= 56) out.push(i);
		}
		return out;
	}
	const movable = $derived(myTurn && game.rolled && game.dice != null ? new Set(legalTokens(myUid, game.dice)) : new Set());

	// flatten all tokens for rendering, keyed stably
	const tokens = $derived(
		game.players.flatMap((uid) =>
			game.tokens[uid].map((_, i) => {
				const [cr, cc] = tokenCentre(uid, i);
				return { key: `${uid}-${i}`, uid, i, color: game.colors[uid], cr, cc };
			})
		)
	);

	onMount(() => {
		muted = isMuted();
		arm();
	});
	function toggleMute() {
		muted = !muted;
		setMuted(muted);
	}

	// Cube rotation (deg) that brings each face to the front. TILT keeps a little
	// 3D angle even when settled so the die never looks flat.
	const ORIENT = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
	const TILT_X = -18;
	const TILT_Y = 14;
	const canRoll = $derived(myTurn && !game.rolled && !rolling && !game.result);

	function showValue(value, spins) {
		const [rx, ry] = ORIENT[value] || ORIENT[1];
		baseX += spins * 360;
		baseY += spins * 360;
		shownValue = value;
		cubeRX = baseX + rx + TILT_X;
		cubeRY = baseY + ry + TILT_Y;
	}

	function swipeStart(e) {
		if (!canRoll) return;
		swipe = { x: e.clientX, y: e.clientY };
		e.currentTarget.setPointerCapture?.(e.pointerId);
	}

	// The value IS the swipe: further/harder swipe → higher number (1-6).
	function swipeEnd(e) {
		if (!swipe) return;
		const dx = e.clientX - swipe.x;
		const dy = e.clientY - swipe.y;
		swipe = null;
		const dist = Math.hypot(dx, dy);
		if (dist < 12) return; // a tap, not a throw — ignore
		const value = Math.min(6, Math.max(1, 1 + Math.floor(dist / 45)));
		const spins = 2 + Math.min(3, Math.floor(dist / 90));
		roll(value, spins);
	}

	// keyboard fallback (accessibility): a plain random throw
	function keyRoll(e) {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		if (!canRoll) return;
		roll(1 + Math.floor(Math.random() * 6), 3);
	}

	async function roll(value, spins = 2) {
		if (!canRoll) return;
		error = '';
		rolling = true;
		showValue(value, spins); // tumble the cube to the swiped face
		try {
			await store.post('ludo/roll', { die: value });
		} catch (e) {
			error = e.message;
		} finally {
			setTimeout(() => (rolling = false), 650); // let the tumble finish
		}
	}

	async function move(i) {
		if (!myTurn || !game.rolled || posting || !movable.has(i)) return;
		error = '';
		posting = true;
		try {
			await store.post('ludo/move', { token: i });
		} catch (e) {
			error = e.message;
		} finally {
			posting = false;
		}
	}

	// auto-play the only legal move so a forced move needs no extra tap — once
	// per state version so it never loops on itself. The move() call is deferred
	// off the effect (a plain timer): move() writes state via store.post, which
	// must never run synchronously inside an effect (same rule as the thief deal).
	let autoV = -1;
	$effect(() => {
		if (myTurn && game.rolled && game.dice != null && game.v !== autoV) {
			const lt = legalTokens(myUid, game.dice);
			if (lt.length === 1) {
				autoV = game.v;
				const only = lt[0];
				setTimeout(() => move(only), 0);
			}
		}
	});

	// state-driven sound — fires on real state changes (poll OR push), not the
	// click, so spectators hear it too. Plain lets so the effect doesn't depend
	// on what it writes; soundReady skips the first (arrival) run.
	let soundedV = null;
	let soundReady = false;
	$effect(() => {
		const v = game.v;
		const ev = game.lastEvent;
		if (ev && v !== soundedV) {
			soundedV = v;
			if (soundReady) {
				if (ev.kind === 'roll') playDice();
				else if (ev.kind === 'capture') playCapture();
				else if (ev.kind === 'home') playHome();
				else if (ev.kind === 'move') playMove();
				else if (ev.kind === 'pass') playPass();
			}
		}
		soundReady = true;
	});

	// pip layout per die face (3×3 grid slots that are filled)
	const PIPS = {
		1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
	};
	// Explain a passed turn — otherwise a non-6 (which can't leave the yard) just
	// silently flips to the next player and feels like the game is stuck.
	const lastRoll = $derived.by(() => {
		const ev = game.lastEvent;
		if (!ev || ev.kind !== 'pass') return '';
		const who = Number(ev.uid) === myUid ? 'You' : nameOf(ev.uid);
		return ev.reason === 'three-sixes'
			? `${who} rolled three 6s — turn forfeited`
			: `${who} rolled ${ev.die} — no legal move, turn passes`;
	});

	const cssColor = (c) => `var(--ludo-${c})`;
	const winnerName = $derived(game.result ? nameOf(game.result) : null);
</script>

<div class="card" style="padding:18px; {theme.style}">
	<div class="ld-head">
		<h2 class="section-title" style="margin:0;">🎲 Ludo</h2>
		<button
			class="sound-btn"
			onclick={() => (showThemes = !showThemes)}
			aria-expanded={showThemes}
			aria-label="Board colours"
			title="Board colours"
		>
			🎨
		</button>
		<button class="sound-btn" onclick={toggleMute} aria-label={muted ? 'Turn sound on' : 'Turn sound off'}>
			{muted ? '🔇' : '🔊'}
		</button>
	</div>

	{#if showThemes}
		<ThemePicker
			groups={[
				{
					label: 'Colours',
					selected: theme.id,
					onselect: (id) => theme.set(id),
					options: LUDO_THEMES.map((t) => ({
						id: t.id,
						label: t.label,
						swatch: { colors: [t.colors.red, t.colors.green, t.colors.yellow, t.colors.blue] }
					}))
				}
			]}
		/>
	{/if}

	<!-- players + turn indicator -->
	<div class="players">
		{#each game.players as uid (uid)}
			<div class="pl" class:pl--now={uid === currentUid && !game.result} style="--pc:{cssColor(game.colors[uid])}">
				<Avatar uid={Number(uid)} name={nameOf(uid)} size={30} ring={uid === game.result ? 'gold' : uid === currentUid && !game.result ? 'accent' : 'none'} glow={uid === game.result || (uid === currentUid && !game.result)} />
				<span class="pl-name">{nameOf(uid)}{Number(uid) === myUid ? ' (you)' : ''}</span>
				<span class="pl-dot"></span>
			</div>
		{/each}
	</div>

	{#if error}<p class="error-text">{error}</p>{/if}

	<!-- theme vars repeated here on purpose: `portal` moves this node to <body> in
	     fullscreen, so anything inherited from the card above is lost -->
	<div
		class="play-area"
		class:play-area--fs={fs.isFs}
		style={theme.style}
		bind:this={playArea}
		use:portal={fs.isFs}
	>
	<div class="board-wrap">
		<div class="board">
			{#each cells as cell (cell.r * N + cell.c)}
				<div
					class="cell cell--{cell.kind}"
					class:cell--safe={cell.safe}
					style={cell.color ? `--cc:${cssColor(cell.color)}` : ''}
				>
					{#if cell.safe}<span class="star">★</span>{/if}
				</div>
			{/each}

			<!-- tokens overlay -->
			{#each tokens as tk (tk.key)}
				<button
					class="token"
					class:token--movable={movable.has(tk.i) && tk.uid === myUid}
					class:token--mine={tk.uid === myUid}
					style="top:{pct(tk.cr)}; left:{pct(tk.cc)}; --tc:{cssColor(tk.color)}"
					disabled={!(movable.has(tk.i) && tk.uid === myUid)}
					onclick={() => move(tk.i)}
					aria-label="{tk.color} token {tk.i + 1}"
				></button>
			{/each}
		</div>
	</div>

	<!-- dice + status -->
	<div class="controls">
		<div class="dice-wrap">
			<div
				class="dice3d"
				class:dice3d--live={canRoll}
				class:dice3d--rolling={rolling}
				data-value={shownValue}
				role="button"
				tabindex="0"
				aria-label="Swipe the die to roll — swipe further for a higher number"
				onpointerdown={swipeStart}
				onpointerup={swipeEnd}
				onkeydown={keyRoll}
			>
				<div class="cube" style="transform: rotateX({cubeRX}deg) rotateY({cubeRY}deg);">
					{#each [1, 2, 3, 4, 5, 6] as f (f)}
						<div class="face face--{f}">
							<span class="fpips">
								{#each Array(9) as _, s (s)}
									<span class="pip" class:pip--on={PIPS[f]?.includes(s)}></span>
								{/each}
							</span>
						</div>
					{/each}
				</div>
			</div>
		</div>

		<div class="status">
			{#if game.result}
				<strong class="win">🏆 {winnerName} wins!</strong>
			{:else if myTurn && !game.rolled}
				<span>Your turn — swipe the die to roll (further = higher).</span>
			{:else if myTurn && game.rolled}
				<span>You rolled <strong>{game.dice}</strong> — tap a glowing token.</span>
			{:else}
				<span class="muted"><strong>{nameOf(currentUid)}</strong>'s turn…</span>
			{/if}
			{#if lastRoll && !game.result}<span class="roll-log">🎲 {lastRoll}</span>{/if}
			{#if myColor}<span class="you-are">You are <span class="swatch" style="background:{cssColor(myColor)}"></span>{myColor}</span>{/if}
		</div>
	</div>

		<button
			class="btn btn--ghost btn--sm fs-btn"
			onclick={fs.toggle}
			title={fs.isFs ? 'Exit fullscreen (Esc)' : 'Fullscreen board'}
		>
			{fs.isFs ? '✕ Exit' : '⛶ Fullscreen'}
		</button>
	</div>
</div>

<style>
	.ld-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
	}
	.sound-btn {
		background: none;
		border: 1px solid var(--border);
		border-radius: 50%;
		width: 32px;
		height: 32px;
		font-size: 0.95rem;
		cursor: pointer;
		color: var(--text);
	}
	.sound-btn:hover { border-color: var(--accent); }

	.players {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 14px;
	}
	.pl {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 12px 5px 6px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		position: relative;
	}
	.pl--now {
		border-color: var(--pc);
		box-shadow: 0 0 0 1px var(--pc), 0 0 14px -4px var(--pc);
	}
	.pl-name {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.9rem;
	}
	.pl-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--pc);
		box-shadow: 0 0 6px -1px var(--pc);
	}

	.play-area {
		position: relative;
	}
	.board-wrap {
		max-width: 480px;
		margin: 0 auto;
	}
	.fs-btn {
		display: block;
		margin: 12px auto 0;
	}

	/* Fullscreen overlay (CSS-driven; the shared module gates the native API to
	   desktop). The board AND the dice/controls live inside so Ludo stays fully
	   playable in fullscreen. `svh` keeps it clear of the mobile browser chrome. */
	.play-area--fs {
		position: fixed;
		inset: 0 0 auto 0;
		height: 100svh;
		z-index: 100;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		overflow: auto;
		background: var(--bg);
		padding: calc(10px + env(safe-area-inset-top)) calc(6px + env(safe-area-inset-right))
			calc(10px + env(safe-area-inset-bottom)) calc(6px + env(safe-area-inset-left));
	}
	.play-area--fs .board-wrap {
		width: 100%;
		/* reserve room for the dice/controls row + exit button below the board */
		max-width: min(100%, calc(100svh - 200px));
		margin: 0;
	}
	.play-area--fs .controls {
		margin-top: 0;
	}
	.play-area--fs .fs-btn {
		margin: 0;
	}
	.board {
		position: relative;
		width: 100%;
		aspect-ratio: 1;
		display: grid;
		grid-template-columns: repeat(15, 1fr);
		grid-template-rows: repeat(15, 1fr);
		gap: 0;
		padding: 8px;
		border-radius: var(--radius);
		background: var(--bg-soft);
		border: 1px solid var(--border);
		box-shadow: var(--shadow);
	}
	.cell {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	/* the neutral shared-track squares */
	.cell--track {
		background: var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--border);
	}
	/* a coloured start/safe/home-lane square */
	.cell--track[style] { background: color-mix(in srgb, var(--cc, var(--surface-2)) 30%, var(--surface-2)); }
	.cell--safe {
		background: color-mix(in srgb, var(--cc, var(--accent)) 22%, var(--surface-2));
	}
	.cell--home { background: color-mix(in srgb, var(--cc) 55%, var(--surface)); }
	.cell--yard { background: color-mix(in srgb, var(--cc) 20%, var(--surface)); }
	.cell--center { background: color-mix(in srgb, var(--cc, var(--surface)) 65%, var(--surface)); }
	.cell--gap { background: transparent; }
	.star {
		font-size: 0.7em;
		line-height: 1;
		color: color-mix(in srgb, var(--cc, var(--gold)) 70%, var(--text));
		opacity: 0.9;
	}

	/* tokens sit on an overlay, positioned by % so CSS can glide them */
	.token {
		position: absolute;
		width: 5.2%;
		height: 5.2%;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--tc) 55%, #fff), var(--tc) 70%);
		border: 2px solid rgba(255, 255, 255, 0.9);
		box-shadow: 0 2px 5px rgba(0, 0, 0, 0.45);
		padding: 0;
		cursor: default;
		transition: top 0.32s cubic-bezier(0.34, 1.2, 0.5, 1), left 0.32s cubic-bezier(0.34, 1.2, 0.5, 1);
		z-index: 2;
	}
	.token--movable {
		cursor: pointer;
		z-index: 3;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--tc) 55%, transparent), 0 2px 6px rgba(0, 0, 0, 0.5);
		animation: bob 0.9s ease-in-out infinite;
	}
	.token--movable:hover { filter: brightness(1.12); }
	@keyframes bob {
		0%, 100% { transform: translate(-50%, -50%) scale(1); }
		50% { transform: translate(-50%, -62%) scale(1.06); }
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-top: 16px;
	}
	/* 3D die: a CSS cube you swipe to throw */
	.dice-wrap {
		flex: 0 0 auto;
		width: 60px;
		height: 60px;
		perspective: 520px;
	}
	.dice3d {
		width: 60px;
		height: 60px;
		position: relative;
		cursor: grab;
		touch-action: none; /* let us own the swipe instead of scrolling */
		border-radius: 14px;
		outline: none;
	}
	.dice3d:active { cursor: grabbing; }
	.dice3d--live {
		filter: drop-shadow(0 0 7px color-mix(in srgb, var(--accent) 65%, transparent));
	}
	.dice3d--live::after {
		content: '';
		position: absolute;
		inset: -6px;
		border-radius: 18px;
		border: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
		animation: dpulse 1.4s ease-in-out infinite;
		pointer-events: none;
	}
	@keyframes dpulse {
		0%, 100% { opacity: 0.35; transform: scale(0.96); }
		50% { opacity: 0.9; transform: scale(1.04); }
	}
	.cube {
		width: 60px;
		height: 60px;
		position: relative;
		transform-style: preserve-3d;
		transition: transform 0.62s cubic-bezier(0.2, 0.75, 0.3, 1);
	}
	.face {
		position: absolute;
		width: 60px;
		height: 60px;
		display: grid;
		place-items: center;
		padding: 9px;
		border-radius: 12px;
		background: linear-gradient(150deg, #fdfdff, #d7dcec);
		border: 1px solid rgba(20, 30, 55, 0.18);
		box-shadow: inset 0 0 8px rgba(20, 30, 55, 0.14);
		backface-visibility: hidden;
	}
	.face--1 { transform: rotateY(0deg) translateZ(30px); }
	.face--2 { transform: rotateY(90deg) translateZ(30px); }
	.face--3 { transform: rotateX(90deg) translateZ(30px); }
	.face--4 { transform: rotateX(-90deg) translateZ(30px); }
	.face--5 { transform: rotateY(-90deg) translateZ(30px); }
	.face--6 { transform: rotateY(180deg) translateZ(30px); }
	.fpips {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		grid-template-rows: repeat(3, 1fr);
		gap: 2px;
		width: 100%;
		height: 100%;
	}
	.pip { border-radius: 50%; }
	.pip--on {
		background: #1c2333;
		box-shadow: inset 0 -1px 1px rgba(0, 0, 0, 0.4);
	}

	.status {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 0.95rem;
	}
	.win { color: var(--gold); font-size: 1.05rem; }
	.roll-log {
		font-size: 0.82rem;
		color: var(--text-dim);
	}
	.you-are {
		font-size: 0.8rem;
		color: var(--text-dim);
		display: inline-flex;
		align-items: center;
		gap: 5px;
		text-transform: capitalize;
	}
	.swatch {
		width: 11px;
		height: 11px;
		border-radius: 3px;
		border: 1px solid rgba(255, 255, 255, 0.5);
	}

	@media (prefers-reduced-motion: reduce) {
		.token, .token--movable, .die--live, .die--rolling { animation: none; transition: none; }
	}
</style>

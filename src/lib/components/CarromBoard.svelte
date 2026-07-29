<script>
	import { onMount } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { simulate, buildBodies, BOARD } from '$lib/games/carroms-sim.js';
	import { createFullscreen, portal } from '$lib/fullscreen.svelte.js';
	import { createTheme, CARROM_THEMES } from '$lib/themes.svelte.js';
	import ThemePicker from './ThemePicker.svelte';
	import {
		playCarromFlick,
		playCarromHit,
		playCarromWall,
		playCarromPocket,
		playCarromFoul,
		isMuted,
		setMuted,
		arm
	} from '$lib/sound.js';

	let { store, game, members, myUid } = $props();
	let canvas = $state(null);
	let error = $state('');
	let posting = $state(false);

	const theme = createTheme({ key: 'gameroom:carrom-theme', themes: CARROM_THEMES });
	let showThemes = $state(false);
	let muted = $state(false);
	const pal = $derived(theme.current.palette);

	onMount(() => {
		muted = isMuted();
		// the AudioContext needs a gesture that has ALREADY happened — waiting until
		// the first shot would silence it (the flick's own pointerup is too late)
		arm();
	});

	function toggleMute() {
		muted = !muted;
		setMuted(muted);
	}

	let boardWrap = $state(null);
	const fs = createFullscreen(() => boardWrap);

	const nameOf = $derived((uid) => members.find((m) => m.uid === uid)?.name || `#${uid}`);
	const currentUid = $derived(game.players[game.turnIdx]);
	const myTurn = $derived(currentUid === myUid && !game.result && !posting);
	const myTeam = $derived(game.players.indexOf(myUid) % 2 === 0 ? 'w' : 'b');

	// striker placement + aiming (shooter only)
	const BASE_Y = BOARD.SIZE - 120;
	let strikerX = $state(BOARD.SIZE / 2);
	let aiming = $state(false);
	let aim = $state(null); // {dx, dy} drag vector
	let animFrames = null; // precomputed sim snapshots while animating
	let animBodies = $state(null);
	let displayPieces = $state(null); // tween target for spectators

	const POCKETS = [
		[30, 30], [BOARD.SIZE - 30, 30], [30, BOARD.SIZE - 30], [BOARD.SIZE - 30, BOARD.SIZE - 30]
	];

	/** Lighten (amt>0, toward white) or darken (amt<0, toward black) a #hex by 0..1.
	 *  Lets the canvas derive highlight/shadow tints straight from the theme palette. */
	function shade(hex, amt) {
		const h = (hex || '#888').replace('#', '');
		const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
		let r = parseInt(n.slice(0, 2), 16);
		let g = parseInt(n.slice(2, 4), 16);
		let b = parseInt(n.slice(4, 6), 16);
		const t = amt < 0 ? 0 : 255;
		const p = Math.min(1, Math.abs(amt));
		r = Math.round(r + (t - r) * p);
		g = Math.round(g + (t - g) * p);
		b = Math.round(b + (t - b) * p);
		return `rgb(${r},${g},${b})`;
	}

	/** A disc with a top-left highlight, rim and drop shadow — the shared look for
	 *  coins and the striker. `ring` draws an extra accent ring (the queen). */
	function disc(ctx, x, y, r, base, ring) {
		const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
		grad.addColorStop(0, shade(base, 0.45));
		grad.addColorStop(0.6, base);
		grad.addColorStop(1, shade(base, -0.18));
		ctx.save();
		ctx.shadowColor = 'rgba(0,0,0,0.45)';
		ctx.shadowBlur = 9;
		ctx.shadowOffsetY = 4;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = grad;
		ctx.fill();
		ctx.restore();
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.strokeStyle = shade(base, -0.45);
		ctx.lineWidth = 2;
		ctx.stroke();
		if (ring) {
			ctx.beginPath();
			ctx.arc(x, y, r * 0.62, 0, Math.PI * 2);
			ctx.strokeStyle = ring;
			ctx.lineWidth = 3;
			ctx.stroke();
		}
	}

	function draw() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		const S = BOARD.SIZE;
		const C = S / 2;
		ctx.clearRect(0, 0, S, S);

		// felt — radial wood gradient, lit at the centre and deepening to the frame
		const felt = ctx.createRadialGradient(C, C, S * 0.1, C, C, S * 0.72);
		felt.addColorStop(0, shade(pal.felt, 0.1));
		felt.addColorStop(1, shade(pal.felt, -0.16));
		ctx.fillStyle = felt;
		ctx.fillRect(0, 0, S, S);

		// frame + inner hairline
		ctx.strokeStyle = pal.frame;
		ctx.lineWidth = 14;
		ctx.strokeRect(7, 7, S - 14, S - 14);
		ctx.strokeStyle = shade(pal.line, 0.1);
		ctx.lineWidth = 2;
		ctx.strokeRect(26, 26, S - 52, S - 52);

		// corner → pocket "arrows": two arcs sweeping toward each corner
		ctx.strokeStyle = shade(pal.queen, 0.05);
		ctx.lineWidth = 4;
		for (const [px, py] of POCKETS) {
			const toward = Math.atan2(C - py, C - px); // points into the board
			for (const rr of [150, 178]) {
				ctx.beginPath();
				ctx.arc(px, py, rr, toward - 0.7, toward + 0.7);
				ctx.stroke();
			}
		}

		// centre design — outer circle, inner ring, six petals
		ctx.strokeStyle = pal.line;
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.arc(C, C, 110, 0, Math.PI * 2);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(C, C, 70, 0, Math.PI * 2);
		ctx.stroke();
		ctx.fillStyle = shade(pal.line, 0.05);
		for (let i = 0; i < 6; i++) {
			const a = (Math.PI / 3) * i;
			ctx.beginPath();
			ctx.arc(C + 90 * Math.cos(a), C + 90 * Math.sin(a), 9, 0, Math.PI * 2);
			ctx.fill();
		}

		// baseline + the two shooting-circles at its ends
		ctx.strokeStyle = pal.line;
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(150, BASE_Y);
		ctx.lineTo(S - 150, BASE_Y);
		ctx.stroke();
		for (const ex of [150, S - 150]) {
			ctx.beginPath();
			ctx.arc(ex, BASE_Y, 16, 0, Math.PI * 2);
			ctx.stroke();
		}

		// pockets — dark well with a rim
		for (const [px, py] of POCKETS) {
			ctx.beginPath();
			ctx.arc(px, py, BOARD.POCKET_R, 0, Math.PI * 2);
			ctx.fillStyle = pal.pocket;
			ctx.fill();
			ctx.beginPath();
			ctx.arc(px, py, BOARD.POCKET_R, 0, Math.PI * 2);
			ctx.strokeStyle = shade(pal.pocket, 0.35);
			ctx.lineWidth = 3;
			ctx.stroke();
		}

		// pieces (animating bodies take precedence)
		const pieces = animBodies
			? animBodies.filter((b) => b.id !== 's' && !b.pocketed)
			: (displayPieces || game.pieces).filter((p) => !p.pocketed);
		for (const p of pieces) {
			const isQ = p.color === 'q' || p.id === 'q';
			const base = isQ ? pal.queen : colorOf(p) === 'w' ? pal.white : pal.black;
			disc(ctx, p.x, p.y, BOARD.R, base, isQ ? '#f2c94c' : null);
		}

		// striker
		let sx = null, sy = null;
		if (animBodies) {
			const s = animBodies.find((b) => b.id === 's');
			if (s && !s.pocketed) { sx = s.x; sy = s.y; }
		} else if (myTurn) {
			sx = strikerX; sy = BASE_Y;
		}
		if (sx != null) {
			disc(ctx, sx, sy, BOARD.STRIKER_R, pal.striker);
			// centre pip
			ctx.beginPath();
			ctx.arc(sx, sy, BOARD.STRIKER_R * 0.28, 0, Math.PI * 2);
			ctx.fillStyle = shade(pal.striker, -0.3);
			ctx.fill();
		}

		// aim line (slingshot: shot goes opposite the drag)
		if (aiming && aim && myTurn) {
			ctx.beginPath();
			ctx.moveTo(strikerX, BASE_Y);
			ctx.lineTo(strikerX - aim.dx * 3, BASE_Y - aim.dy * 3);
			ctx.strokeStyle = 'rgba(255,77,109,0.85)';
			ctx.lineWidth = 5;
			ctx.setLineDash([12, 8]);
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	function colorOf(p) {
		return p.color || (game.pieces.find((g) => g.id === p.id)?.color ?? 'w');
	}

	// redraw on any state change. Dependencies are listed as bare expressions, so
	// `pal` has to appear HERE — reading it inside draw() alone wouldn't register,
	// and a theme switch would leave the canvas on the old palette until the next
	// move repainted it.
	$effect(() => {
		game.pieces; animBodies; strikerX; aim; displayPieces; myTurn; pal;
		draw();
	});

	// spectators/opponents: tween to new positions when a shot result lands
	let lastV = 0;
	$effect(() => {
		if (game.v !== lastV) {
			lastV = game.v;
			// Authoritative state moved, so whatever a failed post complained about is
			// now answered — a dropped connection whose shot actually landed would
			// otherwise leave its warning on screen over a perfectly correct board.
			error = '';
			if (!animBodies) tweenTo(game.pieces);
		}
	});

	/* ---- sound for everyone who didn't take the shot ----------------------
	   `shoot()` only runs on the shooter's client, so without this the rest of
	   the room watches a coin drop in silence. Same shape as ludo's: driven off
	   the state version (poll OR push), plain `let`s so the effect doesn't
	   depend on what it writes, and `soundReady` skips the arrival replay. */
	let skipStateSound = false; // set by shoot(); we already sounded it live
	let soundedV = null;
	let soundReady = false;
	$effect(() => {
		const v = game.v;
		const ev = game.lastEvent;
		if (ev && v !== soundedV) {
			soundedV = v;
			if (skipStateSound) {
				skipStateSound = false; // our own shot, already heard against the animation
			} else if (soundReady && ev.kind === 'shot') {
				if (ev.foul) playCarromFoul();
				if (ev.queen) playCarromPocket('queen');
				else if (ev.pocketed) playCarromPocket('coin');
			}
		}
		soundReady = true;
	});

	function tweenTo(target) {
		const from = (displayPieces || target).map((p) => ({ ...p }));
		const start = performance.now();
		const DUR = 600;
		function frame(t) {
			const k = Math.min(1, (t - start) / DUR);
			// Spectators only receive settled positions, so this path is a straight
			// line, not the real one — easing it out lands the coins softly instead
			// of stopping them dead. Kept short for the same reason: the longer a
			// fake path is on screen, the more it reads as discs sliding through
			// each other.
			const e = 1 - (1 - k) ** 3;
			displayPieces = target.map((p) => {
				const f = from.find((q) => q.id === p.id) || p;
				return { ...p, x: f.x + (p.x - f.x) * e, y: f.y + (p.y - f.y) * e };
			});
			if (k < 1) requestAnimationFrame(frame);
			else displayPieces = null;
		}
		requestAnimationFrame(frame);
	}

	function canvasPoint(e) {
		const rect = canvas.getBoundingClientRect();
		const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
		const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
		return { x: (cx / rect.width) * BOARD.SIZE, y: (cy / rect.height) * BOARD.SIZE };
	}

	function down(e) {
		if (!myTurn || animBodies) return;
		const p = canvasPoint(e);
		if (Math.hypot(p.x - strikerX, p.y - BASE_Y) < BOARD.STRIKER_R * 2.5) {
			aiming = true;
			aim = { dx: 0, dy: 0 };
		} else if (Math.abs(p.y - BASE_Y) < 60) {
			strikerX = Math.max(150, Math.min(BOARD.SIZE - 150, p.x));
		}
		e.preventDefault();
	}

	function move(e) {
		if (!aiming) return;
		const p = canvasPoint(e);
		aim = { dx: p.x - strikerX, dy: p.y - BASE_Y };
		e.preventDefault();
	}

	function up() {
		if (!aiming || !aim) return;
		aiming = false;
		const power = Math.hypot(aim.dx, aim.dy);
		if (power < 15) {
			aim = null;
			return;
		}
		const scale = Math.min(power, 260) / 260;
		const speed = 10 + scale * 30; // sim velocity units
		const vx = (-aim.dx / power) * speed;
		const vy = (-aim.dy / power) * speed;
		aim = null;
		shoot(vx, vy);
	}

	/** Two clicks closer together than this blur into one buzz on a hard break. */
	const MIN_CLICK_GAP_MS = 28;

	/** Sim steps replayed per second of animation. The physics is untouched — this
	 *  is purely how fast the recorded shot is played back. It used to be ~480
	 *  (2 snapshots × 4 steps, once per frame), which flung the striker across the
	 *  board in about three frames; 135 lets a full-power shot run ~1.5s. Lower is
	 *  slower — this constant is the only knob. */
	const SHOT_STEPS_PER_SEC = 135;

	async function shoot(vx, vy) {
		const bodies = buildBodies(game.pieces, strikerX, BASE_Y, vx, vy);
		const frames = [];
		const result = simulate(bodies, (bs) => frames.push(bs.map((b) => ({ ...b }))));
		frames.push(bodies.map((b) => ({ ...b })));
		animFrames = frames;

		playCarromFlick(Math.hypot(vx, vy) / 40);
		// we sound our own shot against the animation below; suppress the echo the
		// state effect would otherwise play a round trip later
		skipStateSound = true;

		// play animation, sounding each impact as it comes on screen, then post the
		// settled result
		await new Promise((resolve) => {
			const events = result.events || [];
			const last = animFrames.length - 1;
			const start = performance.now();
			let ev = 0;
			let lastClickAt = 0;

			/** Sound every impact up to `step`. Called each frame, then once more with
			 *  Infinity so a pocket the final frame landed past is still heard. */
			function sound(step) {
				while (ev < events.length && events[ev].step <= step) {
					const e = events[ev++];
					const now = performance.now();
					if (e.type === 'pocket') {
						if (e.id === 's') playCarromFoul();
						else playCarromPocket(e.id === 'q' ? 'queen' : 'coin');
					} else if (now - lastClickAt >= MIN_CLICK_GAP_MS) {
						lastClickAt = now;
						if (e.type === 'hit') playCarromHit(e.speed);
						else playCarromWall(e.speed);
					}
				}
			}

			// driven off the clock rather than a per-tick frame counter, so the shot
			// takes the same time on a 60Hz and a 144Hz screen and a dropped frame
			// costs smoothness instead of slowing the whole shot down
			function frame(t) {
				const step = ((t - start) / 1000) * SHOT_STEPS_PER_SEC;
				const i = Math.min(Math.round(step), last);
				animBodies = animFrames[i];
				sound(step);
				if (i < last) requestAnimationFrame(frame);
				else {
					sound(Infinity);
					resolve();
				}
			}
			requestAnimationFrame(frame);
		});

		posting = true;
		error = '';
		try {
			await store.post('carroms/shot', {
				positions: bodies.filter((b) => b.id !== 's' && !b.pocketed).map((b) => ({ id: b.id, x: b.x, y: b.y })),
				pocketed: result.pocketed,
				strikerPocketed: result.strikerPocketed
			});
		} catch (e) {
			error = e.message;
		} finally {
			posting = false;
			animBodies = null;
			animFrames = null;
		}
	}

	const remaining = $derived((c) => game.pieces.filter((p) => p.color === c && !p.pocketed).length);
	// Which team is on strike now — the current player's seat parity, same rule as
	// myTeam. Drives the fullscreen turn highlight.
	const currentTeam = $derived(game.turnIdx % 2 === 0 ? 'w' : 'b');
</script>

<div class="card" style="padding:20px;">
	<div class="carrom-head">
		<span class="chip {myTeam === 'w' ? 'chip--green' : ''}">⚪ White: {game.scores.w} ({remaining('w')} left)</span>
		<span class="chip {myTeam === 'b' ? 'chip--green' : ''}">⚫ Black: {game.scores.b} ({remaining('b')} left)</span>
		<span class="head-actions">
			<button
				class="btn btn--ghost btn--sm"
				onclick={() => (showThemes = !showThemes)}
				aria-expanded={showThemes}
				title="Board colours"
			>
				🎨
			</button>
			<button
				class="btn btn--ghost btn--sm"
				onclick={toggleMute}
				aria-label={muted ? 'Turn shot sounds on' : 'Turn shot sounds off'}
				title={muted ? 'Shot sounds off' : 'Shot sounds on'}
			>
				{muted ? '🔇' : '🔊'}
			</button>
		</span>
	</div>

	{#if showThemes}
		<ThemePicker
			groups={[
				{
					label: 'Board',
					selected: theme.id,
					onselect: (id) => theme.set(id),
					options: CARROM_THEMES.map((t) => ({
						id: t.id,
						label: t.label,
						swatch: { colors: [t.palette.felt, t.palette.frame, t.palette.striker] }
					}))
				}
			]}
		/>
	{/if}

	{#if game.result}
		<p class="chip chip--green" style="margin-bottom:10px;">
			{game.result === 'w' ? '⚪ White' : '⚫ Black'} team wins! 🏆
		</p>
	{:else}
		<p class="muted" style="margin:8px 0;">
			{myTurn
				? `Your shot (${myTeam === 'w' ? '⚪ white' : '⚫ black'}) — drag the striker sideways to place, pull back to aim, release to shoot.`
				: `${nameOf(currentUid)}'s turn…`}
			{#if game.coverPending}<span class="chip chip--amber">queen needs cover!</span>{/if}
		</p>
	{/if}
	{#if error}<p class="error-text">{error}</p>{/if}

	<div class="board-wrap" class:board-wrap--fs={fs.isFs} bind:this={boardWrap} use:portal={fs.isFs}>
		<canvas
			bind:this={canvas}
			width={BOARD.SIZE}
			height={BOARD.SIZE}
			class="carrom-canvas"
			onmousedown={down}
			onmousemove={move}
			onmouseup={up}
			onmouseleave={up}
			ontouchstart={down}
			ontouchmove={move}
			ontouchend={up}
		></canvas>
		<button
			class="btn btn--ghost btn--sm fs-btn"
			onclick={fs.toggle}
			title={fs.isFs ? 'Exit fullscreen (Esc)' : 'Fullscreen board'}
		>
			{fs.isFs ? '✕ Exit' : '⛶ Fullscreen'}
		</button>
		{#if fs.isFs}
			<div class="fs-players">
				{#each game.players as uid, i (uid)}
					<span class="turn-chip {i === game.turnIdx ? 'turn-chip--now' : ''}">
						<Avatar {uid} name={nameOf(uid)} size={22} />
						{nameOf(uid)} {i % 2 === 0 ? '⚪' : '⚫'}
					</span>
				{/each}
			</div>
			<div class="fs-status">
				<span class="chip {currentTeam === 'w' ? 'chip--green' : ''}">⚪ {game.scores.w} · {remaining('w')} left</span>
				<span class="fs-turn">
					{#if game.result}
						{game.result === 'w' ? '⚪ White' : '⚫ Black'} wins 🏆
					{:else if myTurn}
						🎯 Your shot ({myTeam === 'w' ? '⚪' : '⚫'})
					{:else}
						{nameOf(currentUid)}'s turn {currentTeam === 'w' ? '⚪' : '⚫'}
					{/if}
				</span>
				<span class="chip {currentTeam === 'b' ? 'chip--green' : ''}">⚫ {game.scores.b} · {remaining('b')} left</span>
			</div>
		{/if}
	</div>

	<div class="turn-row">
		{#each game.players as uid, i (uid)}
			<span class="turn-chip {i === game.turnIdx ? 'turn-chip--now' : ''}">
				<Avatar {uid} name={nameOf(uid)} size={22} />
				{nameOf(uid)} {i % 2 === 0 ? '⚪' : '⚫'}
			</span>
		{/each}
	</div>
</div>

<style>
	.carrom-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}
	.head-actions {
		display: flex;
		gap: 6px;
		margin-left: auto;
	}
	.board-wrap {
		position: relative;
	}
	.carrom-canvas {
		width: 100%;
		/* raised by the room page while a game is on and chat is hidden. The backing
		   store stays BOARD.SIZE and canvasPoint() maps input through rect.width, so
		   growing the CSS box scales the render without touching sim coordinates. */
		max-width: var(--board-cap, 520px);
		aspect-ratio: 1;
		border-radius: var(--radius-sm);
		touch-action: none;
		display: block;
	}
	.fs-btn {
		margin-top: 10px;
	}

	/* Fullscreen overlay (CSS-driven; the shared module gates the native API to
	   desktop). `svh` = small viewport height, so on phones the board never hides
	   behind the browser's collapsing toolbar. */
	.board-wrap--fs {
		position: fixed;
		inset: 0 0 auto 0;
		height: 100svh;
		z-index: 100;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		background: var(--bg);
		padding: calc(8px + env(safe-area-inset-top)) calc(4px + env(safe-area-inset-right))
			calc(8px + env(safe-area-inset-bottom)) calc(4px + env(safe-area-inset-left));
	}
	.board-wrap--fs .carrom-canvas {
		flex: 0 1 auto;
		max-width: none;
		width: min(100%, calc(100svh - 96px));
		max-height: calc(100svh - 88px);
	}
	.board-wrap--fs .fs-btn {
		margin-top: 0;
		flex: 0 0 auto;
	}
	/* Fullscreen stack order (flex column): players (-2) then counts+turn (-1)
	   above the board, controls below. */
	.fs-players {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 8px;
		order: -2;
	}
	.fs-status {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 10px;
		order: -1; /* turn + counts above the board in fullscreen */
	}
	.fs-turn {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text);
	}
	.turn-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}
	.turn-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.82rem;
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--border);
	}
	.turn-chip--now {
		border-color: var(--accent);
		background: var(--surface);
	}
</style>

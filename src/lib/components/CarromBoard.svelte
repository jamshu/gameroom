<script>
	import { onMount } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { simulate, buildBodies, BOARD } from '$lib/games/carroms-sim.js';
	import {
		T_MIN,
		T_MAX,
		sideOfSeat,
		strikerPos,
		alongSide,
		clampT,
		viewRotation,
		toBoard
	} from '$lib/games/carrom-seats.js';
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

	/** Matches --accent in app.css. The canvas can't read a CSS custom property
	 *  without a getComputedStyle round trip on every frame, and this one colour
	 *  is the whole board's "it's live" signal. */
	const ACCENT = '#ff4d6d';

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

	/* ------------------------------- seating ---------------------------------
	   Which edge each player shoots from, and the rotation that brings the
	   viewer's own edge to the bottom of their screen so opponents sit across the
	   board the way they would round a real one. Purely a VIEW transform: it
	   lives in draw() and its inverse in canvasPoint(), and nothing that leaves
	   this component — the sim, the posted positions, the broadcast striker start
	   — ever sees it. See $lib/games/carrom-seats.js for the mapping itself. */
	const mySeat = $derived(game.players.indexOf(myUid)); // -1 for spectators
	const mySide = $derived(sideOfSeat(mySeat, game.players.length));
	const currentSide = $derived(sideOfSeat(game.turnIdx, game.players.length));
	// spectators hold no seat, so their board stays unrotated
	const viewTheta = $derived(mySeat < 0 ? 0 : viewRotation(mySide));

	// striker placement + aiming (shooter only)
	let strikerT = $state(BOARD.SIZE / 2);
	let placing = $state(false); // dragging the striker along the baseline
	let grabOffset = 0; // where on the striker it was grabbed, so it doesn't jump
	let aiming = $state(false);
	let aim = $state(null); // {dx, dy} drag vector, measured from the press point
	let aimAnchor = null; // where the aim drag started, in board coords
	let animBodies = $state(null); // sim snapshot currently on screen
	let displayPieces = $state(null); // tween target on the no-replay fallback path

	// a fresh placement each time the strike comes round, rather than inheriting
	// wherever the last shot happened to leave it
	$effect(() => {
		currentUid;
		strikerT = BOARD.SIZE / 2;
	});

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
	 *  coins and the striker. */
	function disc(ctx, x, y, r, base) {
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
	}

	function draw() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		const S = BOARD.SIZE;
		const C = S / 2;
		ctx.clearRect(0, 0, S, S);

		// Everything below is drawn in ABSOLUTE board coords; this pair spins the
		// finished board so the viewer's own side faces them. canvasPoint() undoes
		// exactly this.
		ctx.save();
		ctx.translate(C, C);
		ctx.rotate(viewTheta);
		ctx.translate(-C, -C);

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
		ctx.strokeStyle = shade(pal.arrow, 0.05);
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

		// One baseline per side with its two shooting circles, as on a real board.
		// The side on strike is picked out in the accent, so whose shot it is reads
		// off the board itself and not just off a name chip.
		for (let side = 0; side < 4; side++) {
			const live = !game.result && side === currentSide;
			const a = strikerPos(side, T_MIN);
			const b = strikerPos(side, T_MAX);
			ctx.strokeStyle = live ? ACCENT : pal.line;
			ctx.lineWidth = live ? 6 : 3;
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
			for (const end of [a, b]) {
				ctx.beginPath();
				ctx.arc(end.x, end.y, 16, 0, Math.PI * 2);
				ctx.stroke();
			}
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

		// pieces (animating bodies take precedence). The `q` filter is for rooms
		// that were mid-match when the red coin was removed — the server drops her
		// on their next shot, this stops her showing as a stray black coin until then.
		const pieces = animBodies
			? animBodies.filter((b) => b.id !== 's' && !b.pocketed)
			: (displayPieces || game.pieces).filter((p) => !p.pocketed && p.color !== 'q');
		for (const p of pieces) {
			if (colorOf(p) === 'q') continue;
			disc(ctx, p.x, p.y, BOARD.R, colorOf(p) === 'w' ? pal.white : pal.black);
		}

		// Striker. Mine while I'm on strike, the animating one during any shot, and
		// otherwise a dim marker on the active player's baseline — it says whose
		// side is live, not where they have actually placed it.
		let sx = null, sy = null, ghost = false;
		if (animBodies) {
			const s = animBodies.find((b) => b.id === 's');
			if (s && !s.pocketed) { sx = s.x; sy = s.y; }
		} else if (myTurn) {
			({ x: sx, y: sy } = strikerPos(mySide, strikerT));
		} else if (!game.result) {
			({ x: sx, y: sy } = strikerPos(currentSide, BOARD.SIZE / 2));
			ghost = true;
		}
		if (sx != null) {
			ctx.save();
			if (ghost) ctx.globalAlpha = 0.3;
			disc(ctx, sx, sy, BOARD.STRIKER_R, pal.striker);
			if (!ghost) {
				// centre pip
				ctx.beginPath();
				ctx.arc(sx, sy, BOARD.STRIKER_R * 0.28, 0, Math.PI * 2);
				ctx.fillStyle = shade(pal.striker, -0.3);
				ctx.fill();
			}
			ctx.restore();
		}

		// aim line (slingshot: shot goes opposite the drag)
		if (aiming && aim && myTurn) {
			const s = strikerPos(mySide, strikerT);
			ctx.beginPath();
			ctx.moveTo(s.x, s.y);
			ctx.lineTo(s.x - aim.dx * 3, s.y - aim.dy * 3);
			ctx.strokeStyle = 'rgba(255,77,109,0.85)';
			ctx.lineWidth = 5;
			ctx.setLineDash([12, 8]);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		ctx.restore();
	}

	function colorOf(p) {
		return p.color || (game.pieces.find((g) => g.id === p.id)?.color ?? 'w');
	}

	// redraw on any state change. Dependencies are listed as bare expressions, so
	// `pal` has to appear HERE — reading it inside draw() alone wouldn't register,
	// and a theme switch would leave the canvas on the old palette until the next
	// move repainted it.
	$effect(() => {
		game.pieces; animBodies; strikerT; aim; displayPieces; myTurn; pal; viewTheta; currentSide;
		draw();
	});

	/* ------------------------------ shot playback ------------------------------
	   The shooter simulates locally and posts the settled result. Everyone ELSE
	   used to get a 600ms straight-line slide to those positions, which read as
	   discs passing through each other. Instead the shot's four INPUTS ride along
	   on game.lastEvent.shot, and every other client re-runs the same
	   deterministic sim against the positions it already holds — so the whole room
	   watches the same shot, with the same impacts, and only then settles onto the
	   server's numbers. */

	/** Sim steps replayed per second of animation. The physics is untouched — this
	 *  is purely how fast the recorded shot is played back. It used to be ~480
	 *  (2 snapshots × 4 steps, once per frame), which flung the striker across the
	 *  board in about three frames; 135 lets a full-power shot run ~1.5s. Lower is
	 *  slower — this constant is the only knob. */
	const SHOT_STEPS_PER_SEC = 135;

	/** Two clicks closer together than this blur into one buzz on a hard break. */
	const MIN_CLICK_GAP_MS = 28;

	let lastV = 0;
	let lastSeq = 0; // highest lastEvent.seq we've already shown
	let prevPieces = null; // last settled positions on screen — the replay baseline
	let shotToken = 0; // bumped by every new shot; a running playback abandons itself
	let booted = false; // first state arrival isn't a move, so it doesn't get a sound

	/** Run a shot to rest, keeping every step as an animation frame. */
	function runShot(pieces, sx, sy, vx, vy) {
		const bodies = buildBodies(pieces, sx, sy, vx, vy);
		const frames = [];
		const result = simulate(bodies, (bs) => frames.push(bs.map((b) => ({ ...b }))));
		frames.push(bodies.map((b) => ({ ...b })));
		return { bodies, frames, result };
	}

	/** Put a recorded shot on screen, sounding each impact as it lands. Driven off
	 *  the clock rather than a per-tick frame counter, so the shot takes the same
	 *  time on a 60Hz and a 144Hz screen and a dropped frame costs smoothness
	 *  instead of slowing the whole shot down. Resolves early once `stale()` goes
	 *  true — a newer authoritative state has landed and this playback is history. */
	function playShot(frames, events, stale) {
		return new Promise((resolve) => {
			const last = frames.length - 1;
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
						else playCarromPocket('coin');
					} else if (now - lastClickAt >= MIN_CLICK_GAP_MS) {
						lastClickAt = now;
						if (e.type === 'hit') playCarromHit(e.speed);
						else playCarromWall(e.speed);
					}
				}
			}

			function frame(t) {
				if (stale()) { resolve(false); return; }
				const step = ((t - start) / 1000) * SHOT_STEPS_PER_SEC;
				const i = Math.min(Math.round(step), last);
				animBodies = frames[i];
				sound(step);
				if (i < last) requestAnimationFrame(frame);
				else {
					sound(Infinity);
					resolve(true);
				}
			}
			requestAnimationFrame(frame);
		});
	}

	/** Re-run someone else's shot from the positions we held before it. */
	async function replay(shot, from) {
		const token = shotToken;
		const { frames, result } = runShot(from, shot.sx, shot.sy, shot.vx, shot.vy);
		playCarromFlick(Math.hypot(shot.vx, shot.vy) / 40);
		await playShot(frames, result.events, () => token !== shotToken);
		// A newer state already claimed the board — don't clear ITS animation
		if (token !== shotToken) return;
		animBodies = null; // hand the board back to the authoritative positions
	}

	$effect(() => {
		const v = game.v;
		if (v === lastV) return;
		lastV = v;
		// Authoritative state moved, so whatever a failed post complained about is
		// now answered — a dropped connection whose shot actually landed would
		// otherwise leave its warning on screen over a perfectly correct board.
		error = '';

		const ev = game.lastEvent;
		const from = prevPieces;
		const first = !booted;
		// `game.v` is the whole ROOM's version — the store stamps it from the state
		// envelope, so a voice join, a member change or a game-type switch bumps it
		// with no shot behind it. Only an unseen shot seq means a shot happened;
		// gating on the version instead would re-animate the last shot off an
		// already-settled board every time someone picked up the mic.
		const shotIsNew = (ev?.seq ?? 0) !== lastSeq;
		lastSeq = ev?.seq ?? 0;
		booted = true;
		prevPieces = game.pieces.map((p) => ({ ...p }));
		if (!shotIsNew) return; // board unchanged — leave whatever is on screen alone

		// A new shot supersedes anything still running: pocket one of your own and
		// the retained turn can deliver a second shot mid-animation, and silently
		// dropping it would leave the board a shot behind.
		shotToken++;

		if (ev.uid === myUid) {
			// our own shot — the local sim already animated it and settled here
			animBodies = null;
			displayPieces = null;
			return;
		}
		if (!first && ev.shot && from) {
			displayPieces = null; // drop any fallback tween still in flight
			replay(ev.shot, from);
			return;
		}
		// No baseline to replay from — a reload, a mid-game join, a shot posted by
		// a client too old to send its inputs. Slide to the settled positions and
		// play the one-line summary the server sent, so it isn't silent.
		animBodies = null;
		tweenTo(from || game.pieces, game.pieces);
		if (!first) {
			if (ev.foul) playCarromFoul();
			else if (ev.pocketed) playCarromPocket('coin');
		}
	});

	function tweenTo(from, target) {
		const start = performance.now();
		const DUR = 600;
		function frame(t) {
			const k = Math.min(1, (t - start) / DUR);
			// This path has no simulated trajectory behind it, so it's a straight
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

	/* --------------------------------- input ---------------------------------- */

	function canvasPoint(e) {
		const rect = canvas.getBoundingClientRect();
		const src = e.touches?.[0] || e;
		// Undo the view rotation draw() applied, so every handler below reasons in
		// absolute board coords — the same space the sim and the server use.
		return toBoard(
			((src.clientX - rect.left) / rect.width) * BOARD.SIZE,
			((src.clientY - rect.top) / rect.height) * BOARD.SIZE,
			viewTheta
		);
	}

	function down(e) {
		if (!myTurn || animBodies) return;
		const p = canvasPoint(e);
		const s = strikerPos(mySide, strikerT);
		if (Math.hypot(p.x - s.x, p.y - s.y) < BOARD.STRIKER_R * 2.5) {
			// Grabbing the striker slides it along the baseline. The offset keeps the
			// disc under the point it was grabbed by instead of snapping its centre
			// to the finger.
			placing = true;
			grabOffset = alongSide(mySide, p) - strikerT;
		} else {
			// Anywhere else pulls a slingshot. The vector is measured from the PRESS
			// point rather than from the striker — measured from the striker, a tap
			// near a far corner would be a full-power shot with no drag at all.
			aiming = true;
			aimAnchor = p;
			aim = { dx: 0, dy: 0 };
		}
		e.preventDefault();
	}

	function move(e) {
		if (!placing && !aiming) return;
		const p = canvasPoint(e);
		if (placing) strikerT = clampT(alongSide(mySide, p) - grabOffset);
		else aim = { dx: p.x - aimAnchor.x, dy: p.y - aimAnchor.y };
		e.preventDefault();
	}

	function up() {
		placing = false; // a released placement drag is never a shot
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

	async function shoot(vxRaw, vyRaw) {
		const start = strikerPos(mySide, strikerT);
		// Round to exactly what the server will broadcast, so the replay everyone
		// else runs starts from the same four numbers this animation did.
		const sx = Math.round(start.x);
		const sy = Math.round(start.y);
		const vx = Math.round(vxRaw * 1000) / 1000;
		const vy = Math.round(vyRaw * 1000) / 1000;

		const token = ++shotToken;
		const { bodies, frames, result } = runShot(game.pieces, sx, sy, vx, vy);
		playCarromFlick(Math.hypot(vx, vy) / 40);
		await playShot(frames, result.events, () => token !== shotToken);

		posting = true;
		error = '';
		try {
			await store.post('carroms/shot', {
				positions: bodies.filter((b) => b.id !== 's' && !b.pocketed).map((b) => ({ id: b.id, x: b.x, y: b.y })),
				pocketed: result.pocketed,
				strikerPocketed: result.strikerPocketed,
				shot: { sx, sy, vx, vy }
			});
		} catch (e) {
			error = e.message;
		} finally {
			posting = false;
			animBodies = null;
		}
	}

	const remaining = $derived((c) => game.pieces.filter((p) => p.color === c && !p.pocketed).length);
	// Which team is on strike now — the current player's seat parity, same rule as
	// myTeam. Drives the fullscreen turn highlight.
	const currentTeam = $derived(game.turnIdx % 2 === 0 ? 'w' : 'b');
</script>

<!-- One definition, rendered EITHER inline or inside the fullscreen portal, never
     both — a second copy would stay reachable by keyboard behind the overlay. -->
{#snippet playerStrip()}
	<div class="turn-row">
		{#each game.players as uid, i (uid)}
			<span class="turn-chip" class:turn-chip--now={uid === currentUid && !game.result}>
				<Avatar
					{uid}
					name={nameOf(uid)}
					size={22}
					ring={uid === game.result ? 'gold' : uid === currentUid && !game.result ? 'accent' : 'none'}
					glow={uid === currentUid && !game.result}
				/>
				{nameOf(uid)}{uid === myUid ? ' (you)' : ''} {i % 2 === 0 ? '⚪' : '⚫'}
			</span>
		{/each}
	</div>
{/snippet}

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
				? `Your shot (${myTeam === 'w' ? '⚪ white' : '⚫ black'}) — drag the striker along your line to place it, then pull back anywhere on the board and release to shoot.`
				: `${nameOf(currentUid)}'s turn…`}
		</p>
	{/if}
	{#if error}<p class="error-text">{error}</p>{/if}

	<div class="board-wrap" class:board-wrap--fs={fs.isFs} bind:this={boardWrap} use:portal={fs.isFs}>
		<canvas
			bind:this={canvas}
			width={BOARD.SIZE}
			height={BOARD.SIZE}
			class="carrom-canvas"
			class:carrom-canvas--live={myTurn}
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
			<div class="fs-players">{@render playerStrip()}</div>
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

	{#if !fs.isFs}{@render playerStrip()}{/if}
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
	/* Your shot: the board itself breathes. CSS rather than a canvas rAF loop —
	   draw() is $effect-driven, and a second persistent loop would fight the one
	   playing back shots. */
	.carrom-canvas--live {
		animation: board-live 2s ease-in-out infinite;
	}
	@keyframes board-live {
		0%, 100% { box-shadow: 0 0 0 2px var(--accent), 0 0 10px -4px var(--accent); }
		50% { box-shadow: 0 0 0 2px var(--accent), 0 0 22px 0 var(--accent); }
	}
	@media (prefers-reduced-motion: reduce) {
		.carrom-canvas--live {
			animation: none;
			box-shadow: 0 0 0 2px var(--accent);
		}
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
	.fs-players .turn-row {
		margin-top: 0;
		justify-content: center;
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
		box-shadow: 0 0 0 1px var(--accent), 0 0 14px -4px var(--accent);
	}
</style>

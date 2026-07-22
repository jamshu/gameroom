<script>
	import Avatar from './Avatar.svelte';
	import { simulate, buildBodies, BOARD } from '$lib/games/carroms-sim.js';

	let { store, game, members, myUid } = $props();
	let canvas = $state(null);
	let error = $state('');
	let posting = $state(false);

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

	function draw() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		const S = BOARD.SIZE;
		ctx.clearRect(0, 0, S, S);
		// board
		ctx.fillStyle = '#e9d3a3';
		ctx.fillRect(0, 0, S, S);
		ctx.strokeStyle = '#8a5a2b';
		ctx.lineWidth = 14;
		ctx.strokeRect(7, 7, S - 14, S - 14);
		// center circle
		ctx.beginPath();
		ctx.arc(S / 2, S / 2, 110, 0, Math.PI * 2);
		ctx.strokeStyle = '#c09a5a';
		ctx.lineWidth = 3;
		ctx.stroke();
		// pockets
		for (const [px, py] of POCKETS) {
			ctx.beginPath();
			ctx.arc(px, py, BOARD.POCKET_R, 0, Math.PI * 2);
			ctx.fillStyle = '#3a2410';
			ctx.fill();
		}
		// baseline
		ctx.strokeStyle = '#c09a5a';
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(150, BASE_Y);
		ctx.lineTo(S - 150, BASE_Y);
		ctx.stroke();

		// pieces (animating bodies take precedence)
		const pieces = animBodies
			? animBodies.filter((b) => b.id !== 's' && !b.pocketed)
			: (displayPieces || game.pieces).filter((p) => !p.pocketed);
		for (const p of pieces) {
			ctx.beginPath();
			ctx.arc(p.x, p.y, BOARD.R, 0, Math.PI * 2);
			ctx.fillStyle = p.color === 'q' || p.id === 'q' ? '#c0392b' : colorOf(p) === 'w' ? '#f7f1e1' : '#2d2a26';
			ctx.fill();
			ctx.strokeStyle = 'rgba(0,0,0,0.35)';
			ctx.lineWidth = 2;
			ctx.stroke();
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
			ctx.beginPath();
			ctx.arc(sx, sy, BOARD.STRIKER_R, 0, Math.PI * 2);
			ctx.fillStyle = '#4a6fa5';
			ctx.fill();
			ctx.strokeStyle = '#fff';
			ctx.lineWidth = 3;
			ctx.stroke();
		}

		// aim line (slingshot: shot goes opposite the drag)
		if (aiming && aim && myTurn) {
			ctx.beginPath();
			ctx.moveTo(strikerX, BASE_Y);
			ctx.lineTo(strikerX - aim.dx * 3, BASE_Y - aim.dy * 3);
			ctx.strokeStyle = 'rgba(124,58,237,0.8)';
			ctx.lineWidth = 5;
			ctx.setLineDash([12, 8]);
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	function colorOf(p) {
		return p.color || (game.pieces.find((g) => g.id === p.id)?.color ?? 'w');
	}

	// redraw on any state change
	$effect(() => {
		game.pieces; animBodies; strikerX; aim; displayPieces; myTurn;
		draw();
	});

	// spectators/opponents: tween to new positions when a shot result lands
	let lastV = 0;
	$effect(() => {
		if (game.v !== lastV) {
			lastV = game.v;
			if (!animBodies) tweenTo(game.pieces);
		}
	});

	function tweenTo(target) {
		const from = (displayPieces || target).map((p) => ({ ...p }));
		const start = performance.now();
		const DUR = 400;
		function frame(t) {
			const k = Math.min(1, (t - start) / DUR);
			displayPieces = target.map((p) => {
				const f = from.find((q) => q.id === p.id) || p;
				return { ...p, x: f.x + (p.x - f.x) * k, y: f.y + (p.y - f.y) * k };
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

	async function shoot(vx, vy) {
		const bodies = buildBodies(game.pieces, strikerX, BASE_Y, vx, vy);
		const frames = [];
		const result = simulate(bodies, (bs) => frames.push(bs.map((b) => ({ ...b }))));
		frames.push(bodies.map((b) => ({ ...b })));
		animFrames = frames;

		// play animation, then post the settled result
		await new Promise((resolve) => {
			let i = 0;
			function frame() {
				animBodies = animFrames[Math.min(i, animFrames.length - 1)];
				i += 2;
				if (i < animFrames.length) requestAnimationFrame(frame);
				else resolve();
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
</script>

<div class="card" style="padding:20px;">
	<div class="carrom-head">
		<span class="chip {myTeam === 'w' ? 'chip--green' : ''}">⚪ White: {game.scores.w} ({remaining('w')} left)</span>
		<span class="chip {myTeam === 'b' ? 'chip--green' : ''}">⚫ Black: {game.scores.b} ({remaining('b')} left)</span>
	</div>

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
		gap: 10px;
	}
	.carrom-canvas {
		width: 100%;
		max-width: 520px;
		aspect-ratio: 1;
		border-radius: var(--radius-sm);
		touch-action: none;
		display: block;
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

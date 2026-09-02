<script>
	// Hide & Fire — 3D arena rendered by Godot (WASM), embedded as a canvas island.
	//
	// THE SPLIT (see src/lib/shared/hidefire.js and the DO `move` frame):
	//  - Godot owns the FAST plane: rendering, FPS input, physics, camo material,
	//    and each frame emits the local player's transform. We relay it to peers
	//    over the ephemeral `hidefire/move` path (~15/s), never touching state.
	//  - This component + the store own the SLOW plane: role, 90s clock, kills,
	//    score — read from `game` (persisted state), written via hidefire/hit and
	//    hidefire/next.
	//
	// Godot bridge (single instance, so plain window globals are enough):
	//  - Godot  -> JS: window.hidefireOnReady(), .hidefireOnTick(json), .hidefireOnHit(uid)
	//  - JS  -> Godot: window.hidefirePushPeers(json), .hidefireSetRound(json)
	//    (Godot registers those two via JavaScriptBridge once it boots.)
	import { onMount } from 'svelte';
	import { initHideFire, applyHit, resolve, nextRound as nextRoundLogic } from '$lib/shared/hidefire.js';

	let { store, game, members, myUid, solo = false } = $props();

	// The bundle is served with `immutable` cache, so a version segment in the path
	// is what makes a changed export actually reload. Dev: always fresh. Prod: bump
	// on any redeploy that re-exports the game. // ponytail: manual bump; wire to a
	// build hash if redeploys get frequent.
	const ENGINE_VERSION = import.meta.env.DEV ? `dev-${Date.now()}` : 'v14';
	const ENGINE_BASE = `/godot/hidefire/${ENGINE_VERSION}`;
	// Godot's single-threaded web export dodges SharedArrayBuffer / COOP-COEP.
	const SEND_HZ = 15;
	const YOU = 0, BOT = 1; // solo-mode uids

	let canvas;
	let stage;
	let status = $state('loading'); // loading | running | missing | error
	let now = $state(Date.now());
	// Coarse pointer / touch → show the on-screen controls.
	const isTouch = typeof window !== 'undefined'
		&& (window.matchMedia?.('(pointer: coarse)')?.matches || 'ontouchstart' in window);
	let isFullscreen = $state(false);
	let deathFlash = $state(false); // red screen flash when you're killed
	// The win overlay waits ~1.2s after the round resolves so the blood/explosion
	// death effects play before the screen is covered.
	let resultShown = $state(false);
	// Solo practice keeps its OWN round state (no store / no Durable Object);
	// multiplayer reads the persisted `game` prop instead.
	let localGame = $state(solo ? initHideFire([YOU, BOT]) : null);

	const g = $derived(solo ? localGame : game);
	const me = $derived(solo ? YOU : myUid);

	const nameOf = (uid) =>
		solo
			? (Number(uid) === BOT ? 'Bot' : 'You')
			: members?.find((m) => Number(m.uid) === Number(uid))?.name || `Player ${uid}`;

	const myTeam = $derived(g?.teams?.[me] ?? null);
	// Legacy spawn/camo label the OLD Godot pck understands (team A -> hider corner,
	// team B -> seeker corner). A rebuilt pck reads `team`/`slot` instead; sending
	// both means team combat works before AND after the export is rebuilt.
	const teamRole = (t) => (t === 'A' ? 'hider' : 'seeker');
	const remainingMs = $derived(Math.max(0, (g?.endsAt ?? 0) - now));
	const remaining = $derived(Math.ceil(remainingMs / 1000));
	const result = $derived(g?.result ?? null);
	// One player drives the timeout resolve (solo: always you).
	const isTimekeeper = $derived(solo || Number(g?.players?.[0]) === Number(me));

	// Death recap: I'm down but the round is still going -> spectate with a banner
	// showing how many of each side are still standing.
	const aliveOf = (team) =>
		(g?.players ?? []).filter((u) => g?.teams?.[u] === team && g?.alive?.[u]).length;
	const iAmDead = $derived(!!g && me != null && g?.alive && g.alive[me] === false && !result);
	const enemyTeam = $derived(myTeam === 'A' ? 'B' : 'A');

	let lastSent = 0;
	let timeoutPoked = false; // timekeeper fired the end-of-round resolve for THIS round

	// --- bridge -------------------------------------------------------------
	// Godot -> JS works by calling window.* directly (onReady/onTick/onHit).
	// JS -> Godot is a POLLED inbox: create_callback proxies get GC'd in the web
	// export, so instead we push peer JSON to __hidefireInbox and set __hidefireRound;
	// Godot drains/watches them each frame.
	function installBridge() {
		window.__hidefireInbox = [];
		window.__hidefireRound = '';
		window.hidefirePushPeers = (json) => { window.__hidefireInbox.push(json); };
		window.hidefireSetRound = (json) => { window.__hidefireRound = json; };
		// Godot PULLS these each frame (its only reliable inbound channel).
		window.hidefireDrain = () => {
			const q = window.__hidefireInbox;
			window.__hidefireInbox = [];
			return JSON.stringify(q);
		};
		window.hidefireRoundJson = () => window.__hidefireRound || '';
		// Godot signals the local player's death → brief red screen flash.
		window.hidefireOnDeath = () => {
			deathFlash = true;
			setTimeout(() => { deathFlash = false; }, 500);
		};
		// Touch input from the on-screen controls. Godot pulls this each frame; we
		// clear the look deltas + one-shot buttons after each read.
		window.__hidefireTouch = { mx: 0, my: 0, crouch: false, lookdx: 0, lookdy: 0, fire: false, paint: false, pose: false, jump: false };
		window.hidefireTouchJson = () => {
			const t = window.__hidefireTouch;
			const out = JSON.stringify(t);
			t.lookdx = 0; t.lookdy = 0; t.fire = false; t.paint = false; t.pose = false; t.jump = false;
			return out;
		};

		window.hidefireOnReady = () => {
			status = 'running';
			pushRound(); // hand Godot the opening round immediately
		};
		// Godot calls this every frame with the local player's transform.
		window.hidefireOnTick = (json) => {
			if (solo) return; // no relay in practice mode
			const t = performance.now();
			if (t - lastSent < 1000 / SEND_HZ) return; // throttle to SEND_HZ
			lastSent = t;
			let data;
			try { data = JSON.parse(json); } catch { return; }
			store.post('hidefire/move', data).catch(() => {});
		};
		// Godot's raycast decided a kill. Client-authoritative.
		window.hidefireOnHit = (victimUid) => {
			const v = Number(victimUid);
			if (solo) {
				// Only two combatants in solo, so the shooter is whichever one isn't the
				// victim — enough for applyHit's friendly-fire guard.
				applyHit(localGame, v, v === YOU ? BOT : YOU);
				resolve(localGame, Date.now());
				localGame = { ...localGame }; // nudge reactivity
				pushRound();
				return;
			}
			store.post('hidefire/hit', { victim: v }).catch(() => {});
		};
	}
	function removeBridge() {
		for (const k of ['hidefireOnReady', 'hidefireOnTick', 'hidefireOnHit',
			'hidefirePushPeers', 'hidefireSetRound', 'hidefireDrain', 'hidefireRoundJson',
			'hidefireOnDeath', 'hidefireTouchJson', '__hidefireInbox', '__hidefireRound', '__hidefireTouch'])
			delete window[k];
	}

	// --- JS -> Godot --------------------------------------------------------
	function pushPeers(data) {
		// Peers include the sender's own echo filter already (DO excludes the mover),
		// so this is only ever other players. Drop our own uid defensively.
		if (Number(data?.uid) === Number(me)) return;
		window.hidefirePushPeers?.(JSON.stringify(data));
	}
	function pushRound() {
		const payload = {
			team: myTeam,
			role: teamRole(myTeam), // legacy fallback for an un-rebuilt pck
			slot: g?.players?.indexOf(me) ?? 0, // spawn offset so teammates don't stack
			you: me,
			endsAt: g?.endsAt,
			alive: g?.alive,
			result
		};
		if (solo) {
			payload.solo = true;
			const botTeam = g?.teams?.[BOT];
			payload.bot = { uid: BOT, team: botTeam, role: teamRole(botTeam) };
		}
		window.hidefireSetRound?.(JSON.stringify(payload));
	}

	// --- Godot engine boot --------------------------------------------------
	async function boot() {
		// Probe the export exists before importing — it's a committed artifact, not
		// built by Vite, so a fresh checkout without the Godot export must not crash.
		try {
			const head = await fetch(`${ENGINE_BASE}/hidefire.js`, { method: 'HEAD' });
			if (!head.ok) { status = 'missing'; return; }
		} catch { status = 'missing'; return; }

		try {
			// The export defines a global `Engine`. Loading via a script tag keeps its
			// own module resolution intact (it fetches the .wasm/.pck relative to base).
			await new Promise((res, rej) => {
				const s = document.createElement('script');
				s.src = `${ENGINE_BASE}/hidefire.js`;
				s.onload = res;
				s.onerror = rej;
				document.head.appendChild(s);
			});
			// eslint-disable-next-line no-undef
			const engine = new Engine({
				canvas,
				executable: `${ENGINE_BASE}/hidefire`,
				mainPack: `${ENGINE_BASE}/hidefire.pck`,
				// 1 = Project: render to a fixed buffer that CSS scales into the stage.
				// The default (Adaptive) sizes the buffer to the whole WINDOW and
				// letterboxes, so on a tall phone the stage clips to a black bar.
				canvasResizePolicy: 1
			});
			window.__hidefireEngine = engine;
			await engine.startGame();
			// status flips to 'running' when Godot calls hidefireOnReady.
		} catch (e) {
			console.error('Godot boot failed', e);
			status = 'error';
		}
	}

	onMount(() => {
		installBridge();
		const offMove = solo ? null : store.onMove?.(pushPeers);
		boot();

		const clock = setInterval(() => {
			now = Date.now();
			// Safety cap hit with both teams still standing: resolve on survivor count.
			if (isTimekeeper && !result && g?.endsAt && Date.now() >= g.endsAt) {
				if (solo) {
					resolve(localGame, Date.now());
					localGame = { ...localGame };
					pushRound();
				} else if (!timeoutPoked) {
					// Fire the timeout resolve ONCE, not every 250ms — otherwise the
					// timekeeper hammers the (Odoo-backed) hit route for the ~seconds it
					// takes the result to propagate back, which rate-limits the app (429).
					timeoutPoked = true;
					store.post('hidefire/hit', {}).catch(() => { timeoutPoked = false; });
				}
			}
		}, 250);

		return () => {
			clearInterval(clock);
			offMove?.();
			removeBridge();
			try { window.__hidefireEngine?.requestQuit?.(); } catch { /* ignore */ }
			delete window.__hidefireEngine;
		};
	});

	// Re-push the round to Godot whenever the persisted round state changes.
	$effect(() => {
		if (status === 'running') pushRound();
	});

	// A fresh round (new endsAt) re-arms the one-shot timeout poke.
	$effect(() => {
		g?.endsAt;
		timeoutPoked = false;
	});

	// Hold the win overlay back so the death effects are visible first.
	$effect(() => {
		if (result) {
			const t = setTimeout(() => { resultShown = true; }, 1200);
			return () => clearTimeout(t);
		}
		resultShown = false;
	});

	async function nextRound() {
		if (solo) {
			localGame = nextRoundLogic(localGame);
			pushRound();
			return;
		}
		try { await store.post('hidefire/next', {}); } catch (e) { console.error(e); }
	}

	// --- touch controls -----------------------------------------------------
	const T = () => window.__hidefireTouch; // shorthand; defined in installBridge
	let joyOn = $state(false);
	let joyX = $state(0), joyY = $state(0); // knob offset in px for rendering
	let joyId = null, lookId = null, lookX = 0, lookY = 0;
	const JOY_R = 46; // joystick radius (px)

	function joyStart(e) {
		joyId = e.pointerId;
		joyOn = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		joyMove(e);
	}
	function joyMove(e) {
		if (e.pointerId !== joyId) return;
		const r = e.currentTarget.getBoundingClientRect();
		let dx = e.clientX - (r.left + r.width / 2);
		let dy = e.clientY - (r.top + r.height / 2);
		const len = Math.hypot(dx, dy) || 1;
		if (len > JOY_R) { dx = (dx / len) * JOY_R; dy = (dy / len) * JOY_R; }
		joyX = dx; joyY = dy;
		// Up (negative screen dy) → forward; get_vector maps move_forward to -y.
		T().mx = dx / JOY_R;
		T().my = dy / JOY_R;
	}
	function joyEnd(e) {
		if (e.pointerId !== joyId) return;
		joyId = null; joyOn = false; joyX = 0; joyY = 0;
		T().mx = 0; T().my = 0;
	}

	// Drag anywhere on the look zone (right side of the stage) to aim.
	function lookStart(e) { lookId = e.pointerId; lookX = e.clientX; lookY = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }
	function lookMove(e) {
		if (e.pointerId !== lookId) return;
		T().lookdx += e.clientX - lookX;
		T().lookdy += e.clientY - lookY;
		lookX = e.clientX; lookY = e.clientY;
	}
	function lookEnd(e) { if (e.pointerId === lookId) lookId = null; }

	const press = (k) => () => { T()[k] = true; };
	const setCrouch = (v) => () => { T().crouch = v; };

	// Fullscreen: a CSS-expand (fixed cover) is the source of truth — it works on
	// iOS (which refuses element requestFullscreen) and never letterboxes to half
	// the screen. We ALSO best-effort the native API so Android hides its chrome.
	function toggleFullscreen() {
		isFullscreen = !isFullscreen;
		if (isFullscreen) {
			(stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage).catch?.(() => {});
		} else if (document.fullscreenElement || document.webkitFullscreenElement) {
			(document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
		}
	}
	function onFsChange() {
		// Native FS exited (Esc/back) → collapse the CSS expand too.
		if (!document.fullscreenElement && !document.webkitFullscreenElement) isFullscreen = false;
	}
	$effect(() => {
		document.addEventListener('fullscreenchange', onFsChange);
		document.addEventListener('webkitfullscreenchange', onFsChange);
		return () => {
			document.removeEventListener('fullscreenchange', onFsChange);
			document.removeEventListener('webkitfullscreenchange', onFsChange);
		};
	});
</script>

<div class="arena">
	<div class="hud">
		<span class="role" class:hider={myTeam === 'A'} class:seeker={myTeam === 'B'}>
			{myTeam === 'A' ? '🟢 Team A' : myTeam === 'B' ? '🔴 Team B' : '…'}
		</span>
		<span class="clock" class:low={remaining <= 10}>{remaining}s</span>
		<span class="score">
			{#each g?.players ?? [] as p (p)}
				<b>{nameOf(p)}: {g.scores?.[p] ?? 0}</b>
			{/each}
		</span>
	</div>

	<div class="stage" class:expanded={isFullscreen} bind:this={stage}>
		<!-- id is REQUIRED: Godot/Emscripten builds the WebGL context's canvas
		     selector as `#<id>`, so a missing id yields the invalid selector `#`. -->
		<canvas bind:this={canvas} id="hidefire-canvas" class="godot" tabindex="0"></canvas>

		<button class="fs-btn" onclick={toggleFullscreen} title="Fullscreen" aria-label="Toggle fullscreen">
			{isFullscreen ? '🡴' : '⛶'}
		</button>

		{#if status === 'running' && !result}
			<div class="crosshair" aria-hidden="true"></div>
		{/if}

		{#if deathFlash}
			<div class="death-flash" aria-hidden="true"></div>
		{/if}

		{#if status === 'running' && !result && isTouch}
			<!-- Look: drag anywhere; joystick + buttons sit on top and grab first. -->
			<div class="look-zone" role="application" aria-label="Look" onpointerdown={lookStart}
				onpointermove={lookMove} onpointerup={lookEnd} onpointercancel={lookEnd}></div>
			<div class="joystick" class:on={joyOn} role="application" aria-label="Move"
				onpointerdown={joyStart} onpointermove={joyMove} onpointerup={joyEnd} onpointercancel={joyEnd}>
				<div class="knob" style="transform: translate({joyX}px, {joyY}px)"></div>
			</div>
			<div class="tbtns">
				<!-- Everyone can hide AND fire in team combat, so camo is available to
				     all (a rebuilt pck enables it; the old one ignores it for team B). -->
				<button class="tbtn" onpointerdown={press('paint')} aria-label="Paint">🎨</button>
				<button class="tbtn" onpointerdown={press('pose')} aria-label="Pose">🧍</button>
				<button class="tbtn" onpointerdown={press('jump')} aria-label="Jump">⤒</button>
				<button class="tbtn fire" onpointerdown={press('fire')} aria-label="Fire">🔥</button>
			</div>
		{/if}

		{#if status !== 'running'}
			<div class="overlay">
				{#if status === 'loading'}
					<p>Loading arena…</p>
				{:else if status === 'missing'}
					<p>3D engine not built yet.</p>
					<small>Export the Godot project to <code>static/godot/hidefire/</code> — see <code>godot/hidefire/README.md</code>.</small>
				{:else if status === 'error'}
					<p>Engine failed to start — check the console.</p>
				{/if}
			</div>
		{/if}

		{#if iAmDead && status === 'running'}
			<div class="recap" aria-live="polite">
				<h3>💀 You're down!</h3>
				<p>
					{myTeam ? `Team ${myTeam}` : 'Your team'}: {aliveOf(myTeam)} left ·
					Team {enemyTeam}: {aliveOf(enemyTeam)} left
				</p>
				<small>Spectating — wait for the round to end.</small>
			</div>
		{/if}

		{#if resultShown}
			<div class="overlay result">
				<h2>
					{result === 'draw'
						? '🤝 Draw!'
						: result === myTeam
							? '🏆 Your team wins!'
							: `Team ${result} wins!`}
				</h2>
				<button onclick={nextRound}>Next round →</button>
			</div>
		{/if}
	</div>

	{#if isTouch}
		<p class="controls">Left stick move · drag to look · 🔥 fire · 🎨 paint · 🧍 pose · ⤒ jump</p>
	{:else}
		<p class="controls">WASD move · mouse look · click fire · <b>E</b> paint body · <b>F</b> pose · <b>Shift</b> crouch</p>
	{/if}
</div>

<style>
	.arena { display: flex; flex-direction: column; gap: 8px; }
	.hud {
		display: flex; align-items: center; gap: 16px; font-size: 14px;
		padding: 6px 10px; background: #0b1120; border-radius: 8px; color: #e5e7eb;
	}
	.role { font-weight: 700; }
	.role.hider { color: #34d399; }
	.role.seeker { color: #f87171; }
	.clock { font-variant-numeric: tabular-nums; font-weight: 700; margin-left: auto; }
	.clock.low { color: #f87171; }
	.score { display: flex; gap: 12px; }
	.stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 8px; overflow: hidden; }
	/* CSS "fullscreen": cover the whole viewport, works on every device. The canvas
	   keeps a 16:9 box centred (no distortion, no half-screen letterbox). */
	.stage.expanded {
		position: fixed; inset: 0; z-index: 9999;
		width: 100vw; height: 100vh; aspect-ratio: auto; border-radius: 0;
		display: grid; place-items: center;
	}
	.godot { width: 100%; height: 100%; display: block; outline: none; }
	.stage.expanded .godot {
		width: auto; height: auto; max-width: 100vw; max-height: 100vh; aspect-ratio: 16 / 9;
	}
	.crosshair {
		position: absolute; top: 50%; left: 50%; width: 18px; height: 18px;
		transform: translate(-50%, -50%); pointer-events: none;
		background:
			linear-gradient(#fff, #fff) center/2px 18px no-repeat,
			linear-gradient(#fff, #fff) center/18px 2px no-repeat;
		opacity: 0.8; mix-blend-mode: difference;
	}
	.overlay {
		position: absolute; inset: 0; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 8px; text-align: center;
		background: rgba(11, 17, 32, 0.85); color: #e5e7eb; padding: 16px;
	}
	.overlay.result h2 { margin: 0; }

	/* Death recap: a bottom banner, NOT a full cover, so the fallen death-cam view
	   stays visible behind it. */
	.recap {
		position: absolute; left: 0; right: 0; bottom: 0; z-index: 6;
		display: flex; flex-direction: column; align-items: center; gap: 2px;
		padding: 10px 12px; text-align: center;
		background: linear-gradient(transparent, rgba(120, 0, 0, 0.55) 40%, rgba(80, 0, 0, 0.85));
		color: #fee2e2; pointer-events: none;
	}
	.recap h3 { margin: 0; font-size: 1.05rem; }
	.recap p { margin: 0; font-size: 0.85rem; }
	.recap small { color: #fca5a5; }
	.overlay button {
		padding: 8px 16px; border: 0; border-radius: 8px; background: #7c3aed;
		color: #fff; font-weight: 700; cursor: pointer;
	}
	.overlay code { background: #1f2937; padding: 1px 4px; border-radius: 4px; }
	.controls { font-size: 12px; color: #6b7280; text-align: center; margin: 0; }

	/* Red hit-flash when you're killed. */
	.death-flash {
		position: absolute; inset: 0; z-index: 4; pointer-events: none;
		background: radial-gradient(circle, rgba(200, 0, 0, 0) 35%, rgba(180, 0, 0, 0.65) 100%);
		animation: death-fade 0.5s ease-out forwards;
	}
	@keyframes death-fade { from { opacity: 1; } to { opacity: 0; } }

	/* Fullscreen button (all devices). */
	.fs-btn {
		position: absolute; top: 8px; right: 8px; z-index: 5;
		width: 34px; height: 34px; border: 0; border-radius: 8px;
		background: rgba(11, 17, 32, 0.6); color: #fff; font-size: 16px;
		cursor: pointer; line-height: 1; display: grid; place-items: center;
	}

	/* Touch controls. */
	.look-zone { position: absolute; inset: 0; z-index: 1; touch-action: none; }
	.joystick {
		position: absolute; left: 18px; bottom: 18px; z-index: 3;
		width: 116px; height: 116px; border-radius: 50%;
		background: rgba(255, 255, 255, 0.08); border: 2px solid rgba(255, 255, 255, 0.25);
		touch-action: none; display: grid; place-items: center;
	}
	.joystick.on { background: rgba(255, 255, 255, 0.14); }
	.knob {
		width: 52px; height: 52px; border-radius: 50%;
		background: rgba(255, 255, 255, 0.6); pointer-events: none;
	}
	.tbtns {
		position: absolute; right: 14px; bottom: 18px; z-index: 3;
		display: flex; align-items: flex-end; gap: 12px; touch-action: none;
	}
	.tbtn {
		width: 58px; height: 58px; border-radius: 50%; border: 0;
		background: rgba(255, 255, 255, 0.14); color: #fff; font-size: 22px;
		display: grid; place-items: center; touch-action: none; user-select: none;
		-webkit-user-select: none;
	}
	.tbtn.fire { width: 74px; height: 74px; font-size: 28px; background: rgba(248, 113, 113, 0.35); }
</style>

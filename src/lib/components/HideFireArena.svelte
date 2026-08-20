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
	const ENGINE_VERSION = import.meta.env.DEV ? `dev-${Date.now()}` : 'v1';
	const ENGINE_BASE = `/godot/hidefire/${ENGINE_VERSION}`;
	// Godot's single-threaded web export dodges SharedArrayBuffer / COOP-COEP.
	const SEND_HZ = 15;
	const YOU = 0, BOT = 1; // solo-mode uids

	let canvas;
	let status = $state('loading'); // loading | running | missing | error
	let now = $state(Date.now());
	// Solo practice keeps its OWN round state (no store / no Durable Object);
	// multiplayer reads the persisted `game` prop instead.
	let localGame = $state(solo ? initHideFire([YOU, BOT]) : null);

	const g = $derived(solo ? localGame : game);
	const me = $derived(solo ? YOU : myUid);

	const nameOf = (uid) =>
		solo
			? (Number(uid) === BOT ? 'Bot' : 'You')
			: members?.find((m) => Number(m.uid) === Number(uid))?.name || `Player ${uid}`;

	const myRole = $derived(g?.roles?.[me] ?? null);
	const remainingMs = $derived(Math.max(0, (g?.endsAt ?? 0) - now));
	const remaining = $derived(Math.ceil(remainingMs / 1000));
	const result = $derived(g?.result ?? null);
	// One player drives the timeout resolve (solo: always you).
	const isTimekeeper = $derived(solo || Number(g?.players?.[0]) === Number(me));

	let lastSent = 0;

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
				applyHit(localGame, v);
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
			'__hidefireInbox', '__hidefireRound'])
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
		const payload = { role: myRole, you: me, endsAt: g?.endsAt, alive: g?.alive, result };
		if (solo) payload.solo = true, (payload.bot = { uid: BOT, role: g?.roles?.[BOT] });
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
				mainPack: `${ENGINE_BASE}/hidefire.pck`
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
			// Round clock hit zero with no kill: hand it to the hiders.
			if (isTimekeeper && !result && g?.endsAt && Date.now() >= g.endsAt) {
				if (solo) {
					resolve(localGame, Date.now());
					localGame = { ...localGame };
					pushRound();
				} else {
					store.post('hidefire/hit', {}).catch(() => {});
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

	async function nextRound() {
		if (solo) {
			localGame = nextRoundLogic(localGame);
			pushRound();
			return;
		}
		try { await store.post('hidefire/next', {}); } catch (e) { console.error(e); }
	}
</script>

<div class="arena">
	<div class="hud">
		<span class="role" class:hider={myRole === 'hider'} class:seeker={myRole === 'seeker'}>
			{myRole === 'hider' ? '🫥 Hide' : myRole === 'seeker' ? '🔫 Seek' : '…'}
		</span>
		<span class="clock" class:low={remaining <= 10}>{remaining}s</span>
		<span class="score">
			{#each g?.players ?? [] as p (p)}
				<b>{nameOf(p)}: {g.scores?.[p] ?? 0}</b>
			{/each}
		</span>
	</div>

	<div class="stage">
		<!-- id is REQUIRED: Godot/Emscripten builds the WebGL context's canvas
		     selector as `#<id>`, so a missing id yields the invalid selector `#`. -->
		<canvas bind:this={canvas} id="hidefire-canvas" class="godot" tabindex="0"></canvas>

		{#if status === 'running' && !result}
			<div class="crosshair" aria-hidden="true"></div>
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

		{#if result}
			<div class="overlay result">
				<h2>{result === 'seekers' ? '🔫 Seekers win!' : '🫥 Hiders win!'}</h2>
				<button onclick={nextRound}>Next round →</button>
			</div>
		{/if}
	</div>

	<p class="controls">WASD move · mouse look · click fire · <b>E</b> paint body · <b>F</b> pose · <b>Shift</b> crouch</p>
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
	.godot { width: 100%; height: 100%; display: block; outline: none; }
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
	.overlay button {
		padding: 8px 16px; border: 0; border-radius: 8px; background: #7c3aed;
		color: #fff; font-weight: 700; cursor: pointer;
	}
	.overlay code { background: #1f2937; padding: 1px 4px; border-radius: 4px; }
	.controls { font-size: 12px; color: #6b7280; text-align: center; margin: 0; }
</style>

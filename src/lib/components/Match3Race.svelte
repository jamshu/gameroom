<script>
	// The multiplayer half of Candy Match.
	//
	// Unlike the sudoku race, the board lives HERE, on the client: the refill
	// queue is unbounded, so it cannot be dealt up front and is generated locally
	// from the shared seed. Every player therefore starts from the same board and
	// diverges only as their own moves do — which is the game. The consequence is
	// that the score is computed locally too; it is reported once at the finish
	// and CLAMPED server-side (see applyMatch3Finish).
	//
	// Two channels, deliberately different:
	//   the running score  -> match3/tick, ephemeral, no state version, ~every 2s
	//   the final score    -> match3/finish, authoritative, once
	import { onDestroy } from 'svelte';
	import Match3Board from './Match3Board.svelte';
	import { openRound, applySwap, GRACE_MS } from '$lib/shared/match3.js';

	let { store, game, members, myUid } = $props();

	/** How often the running score goes out. Every couple of seconds is enough to
	 *  feel live; faster would just be traffic, since nothing durable rides on it. */
	const TICK_MS = 2000;

	const nameOf = (uid) =>
		members?.find((m) => Number(m.uid) === Number(uid))?.name || `Player ${uid}`;

	let board = $state([]);
	let score = $state(0);
	let reported = $state(false);
	let live = $state({}); // { uid: score } from the ephemeral tick channel

	// The rng IS the refill queue, so it must survive every swap. A plain `let`:
	// it is drawn from constantly and nothing renders off it.
	let rng = null;
	let seeded = null; // which seed the board above was built from
	let lastTickAt = 0;

	let now = $state(Date.now());
	const timer = setInterval(() => (now = Date.now()), 250);
	onDestroy(() => clearInterval(timer));

	const amPlayer = $derived(!!game?.scores?.[myUid]);
	const endsAt = $derived((game?.startedAt ?? 0) + (game?.durationMs ?? 0));
	const timeLeftMs = $derived(Math.max(0, endsAt - now));
	const finished = $derived(!!game?.result);
	const expired = $derived(timeLeftMs === 0);

	/* Build the board when the seed appears or changes. Keyed on the seed rather
	   than done once on mount: a rematch reuses this component with a NEW seed
	   (initGame mints one per game), and rebuilding is the only thing that has to
	   happen for the next round to be dealt. */
	$effect(() => {
		const seed = game?.seed;
		if (!seed || seed === seeded) return;
		const round = openRound(seed);
		board = round.board;
		rng = round.rng;
		seeded = seed;
		score = 0;
		reported = false;
		live = {};
		swaps = []; // MUST reset with the board, or a rematch would report the
		            // previous round's log appended to the new one
	});

	/* Report once the clock is out. The server recomputes expiry from its own
	   startedAt and refuses anything early, so this is a request, not a claim —
	   the same arrangement chess/flag uses. */
	$effect(() => {
		if (expired && amPlayer && !reported && game?.seed) report();
	});

	/* Then nudge once more after the grace window if the round STILL has not
	   ended, which means somebody never reported — a closed tab, a dead
	   connection. That second call is what closes them out; there is no alarm on
	   the server doing it, by design. One timer, cleared on unmount and re-armed
	   only while the round is genuinely stuck. */
	$effect(() => {
		if (!reported || finished || !amPlayer) return;
		const wait = Math.max(0, endsAt + GRACE_MS - Date.now()) + 250;
		const t = setTimeout(() => store.post('match3/finish', {}).catch(() => {}), wait);
		return () => clearTimeout(t);
	});

	async function report() {
		reported = true; // set FIRST: the effect above can re-run while this awaits
		try {
			await store.post('match3/finish', { score, swaps: swaps.length, log: swaps });
		} catch {
			// Nothing to retry into — the nudge effect above covers a round that is
			// still open, and a round that closed without us is already decided.
		}
	}

	let swaps = [];

	function swap(a, b) {
		if (!amPlayer || expired || finished) return { ok: false };
		const res = applySwap(board, a, b, rng);
		if (!res.ok) return { ok: false };
		board = res.board;
		score += res.gained;
		swaps.push([a, b]);
		sendTick();
		return { ok: true, gained: res.gained, cascades: res.cascades };
	}

	/** Throttled — a fast player can chain several swaps a second and each one
	 *  would otherwise be a request. Nothing durable rides on a skipped tick. */
	function sendTick() {
		const t = Date.now();
		if (t - lastTickAt < TICK_MS) return;
		lastTickAt = t;
		store.post('match3/tick', { score }).catch(() => {});
	}

	/* Subscribe inside an effect so the disposer runs on unmount and the handler
	   re-binds if `store` is ever swapped — subscribing at the top level would
	   capture only the store this component was created with. */
	$effect(() => {
		const dispose = store.onTick?.((d) => {
			if (!d || Number(d.uid) === Number(myUid)) return;
			live = { ...live, [d.uid]: Number(d.score) || 0 };
		});
		return () => dispose?.();
	});

	/** Rivals, preferring each player's authoritative final score once they have
	 *  reported and falling back to their last live tick while they are playing. */
	const rivals = $derived(
		Object.entries(game?.scores ?? {})
			.filter(([uid]) => Number(uid) !== Number(myUid))
			.map(([uid, s]) => ({
				uid: Number(uid),
				name: nameOf(uid),
				score: s?.finishedAt ? (s.score ?? 0) : (live[uid] ?? 0)
			}))
			.sort((a, b) => b.score - a.score)
	);

	const winners = $derived.by(() => {
		if (!finished) return [];
		const top = Math.max(0, ...Object.values(game.scores ?? {}).map((s) => s?.score || 0));
		if (top <= 0) return [];
		return Object.keys(game.scores).filter((u) => (game.scores[u]?.score || 0) === top).map(Number);
	});
	const iWon = $derived(winners.includes(Number(myUid)));
</script>

{#if finished}
	<p class="verdict" class:won={iWon}>
		{#if !winners.length}
			Nobody scored — call it a draw.
		{:else if iWon && winners.length > 1}
			🏆 Tied for the win with {winners.filter((u) => u !== myUid).map(nameOf).join(', ')}
		{:else if iWon}
			🏆 You win with {(game.scores[myUid]?.score ?? 0).toLocaleString()}!
		{:else}
			{winners.map(nameOf).join(' & ')} wins
		{/if}
	</p>
{:else if expired && amPlayer}
	<p class="muted verdict">Time! Waiting for the others to finish…</p>
{:else if !amPlayer}
	<p class="muted verdict">Spectating — scores update as they play.</p>
{/if}

<Match3Board
	{board}
	{score}
	timeLeftMs={finished ? 0 : timeLeftMs}
	disabled={!amPlayer || expired || finished}
	{rivals}
	onSwap={swap}
/>

<style>
	.verdict {
		text-align: center;
		font-weight: 700;
		margin: 0 0 8px;
		color: var(--text-dim);
	}
	.verdict.won {
		color: var(--accent);
	}
</style>

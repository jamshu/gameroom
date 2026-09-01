<script>
	// The multiplayer half of bird sort: whose tubes are whose, the rival ticker,
	// and where a pour gets POSTed — so BirdsortBoard stays a pure board the solo
	// page uses unchanged.
	//
	// Every pour is a round trip and the SERVER decides legality (see
	// applyBirdsortMove). A client cannot fake "first to sort".
	import BirdsortBoard from './BirdsortBoard.svelte';

	let { store, game, members, myUid } = $props();

	const nameOf = (uid) =>
		members?.find((m) => Number(m.uid) === Number(uid))?.name || `Player ${uid}`;

	// gameView projects everyone but me down to {progress,total,pct,moves,doneAt}
	// and keeps my own `tubes`. A spectator has no entry at all.
	const mine = $derived(game?.boards?.[myUid] ?? null);
	const amPlayer = $derived(!!mine);

	const rivals = $derived(
		Object.entries(game?.boards ?? {})
			.filter(([uid]) => Number(uid) !== Number(myUid))
			.map(([uid, b]) => ({
				uid: Number(uid),
				name: nameOf(uid),
				pct: b?.pct ?? 0,
				done: !!b?.doneAt
			}))
			.sort((a, b) => b.pct - a.pct)
	);

	const finished = $derived(!!game?.result);
	const iWon = $derived(Number(game?.result) === Number(myUid));

	/** Send one pour. `{ ok:false }` on a refused/illegal move so the board shakes
	 *  rather than treating it as done. */
	async function move(from, to) {
		try {
			await store.post('birdsort/move', { from, to });
			return { ok: true };
		} catch {
			return { ok: false };
		}
	}
</script>

{#if finished}
	<p class="verdict" class:won={iWon}>
		{iWon ? '🏆 You sorted them first!' : `${nameOf(game.result)} sorted them first`}
	</p>
{:else if !amPlayer}
	<p class="muted spectating">Spectating — you can see how far everyone has got.</p>
{/if}

<BirdsortBoard
	tubes={mine?.tubes ?? []}
	done={finished}
	disabled={!amPlayer}
	{rivals}
	onMove={move}
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
	.spectating {
		text-align: center;
		margin: 0 0 8px;
	}
</style>

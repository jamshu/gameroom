<script>
	// The multiplayer half of sudoku: everything room-shaped — whose board is
	// whose, what the rival ticker says, where a digit gets POSTed — so that
	// SudokuBoard stays a pure grid the solo page can use unchanged.
	//
	// There is no local rules copy here on purpose. The solution never reaches the
	// client, so every digit is a round trip and the SERVER decides whether it was
	// right. That is also what enforces the ten-second freeze: a client ignoring
	// its own countdown is still refused (see applySudokuFill).
	import SudokuBoard from './SudokuBoard.svelte';

	let { store, game, members, myUid } = $props();

	const nameOf = (uid) =>
		members?.find((m) => Number(m.uid) === Number(uid))?.name || `Player ${uid}`;

	// gameView projects everyone but me down to {progress,total,pct,mistakes,doneAt}
	// and keeps my own `filled`/`frozenUntil`. A spectator has no entry at all.
	const mine = $derived(game?.boards?.[myUid] ?? null);
	const amPlayer = $derived(!!mine);

	const rivals = $derived(
		Object.entries(game?.boards ?? {})
			.filter(([uid]) => Number(uid) !== Number(myUid))
			.map(([uid, b]) => ({
				uid: Number(uid),
				name: nameOf(uid),
				pct: b?.pct ?? 0,
				mistakes: b?.mistakes ?? 0,
				done: !!b?.doneAt
			}))
			// furthest along first, so the person to beat is at the top
			.sort((a, b) => b.pct - a.pct)
	);

	const finished = $derived(!!game?.result);
	const iWon = $derived(Number(game?.result) === Number(myUid));

	/**
	 * Send one digit. Returns `{ correct }` for the board's flash — anything else
	 * (a rejection, a dropped request) is reported as "nothing happened" rather
	 * than as a wrong answer, so a flaky connection never costs a mistake.
	 */
	async function fill(cell, digit) {
		try {
			const res = await store.post('sudoku/fill', { cell, digit });
			return { ok: true, correct: res?.correct !== false };
		} catch {
			return { ok: false };
		}
	}
</script>

{#if finished}
	<p class="verdict" class:won={iWon}>
		{iWon ? '🏆 You solved it first!' : `${nameOf(game.result)} solved it first`}
	</p>
{:else if !amPlayer}
	<p class="muted spectating">Spectating — you can see how far everyone has got.</p>
{/if}

<SudokuBoard
	puzzle={game.puzzle}
	filled={mine?.filled ?? {}}
	mistakes={mine?.mistakes ?? 0}
	frozenUntil={mine?.frozenUntil ?? 0}
	done={finished}
	disabled={!amPlayer}
	{rivals}
	onFill={fill}
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

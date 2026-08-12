<script>
	// Multiplayer Go Fish. `game` is the per-session view: my hand in full, every
	// rival hand as a count, books public. To ask, pick a rival then a rank you
	// hold — the server enforces "must hold the rank" too (see gofish.ask).
	import PlayingCard from './PlayingCard.svelte';
	import { rankLabel } from '$lib/shared/cards.js';
	import { playMove, playCapture, arm } from '$lib/sound.js';

	let { store, game, members, myUid } = $props();

	const nameOf = (uid) =>
		members?.find((m) => Number(m.uid) === Number(uid))?.name || `Player ${uid}`;

	const myHand = $derived(Array.isArray(game.hands?.[myUid]) ? game.hands[myUid] : []);
	const myRanks = $derived([...new Set(myHand.map((c) => c.r))].sort((a, b) => a - b));
	const myTurn = $derived(Number(game.players[game.turnIdx]) === Number(myUid) && !game.result);

	const rivals = $derived(
		game.players
			.filter((u) => Number(u) !== Number(myUid))
			.map((u) => ({
				uid: Number(u),
				name: nameOf(u),
				count: game.hands?.[u]?.count ?? 0,
				books: game.books?.[u]?.length ?? 0
			}))
	);
	const myBooks = $derived(game.books?.[myUid]?.length ?? 0);

	let target = $state(null);
	let busy = $state(false);

	async function ask(rank) {
		if (busy || !myTurn || target == null) return;
		busy = true;
		try {
			arm();
			const res = await store.post('gofish/ask', { target, rank });
			res?.ask?.got === 'fish' ? playCapture() : playMove();
			if (res?.ask?.got === 'fish') target = null; // turn likely passed; reset the pick
		} catch (e) {
			console.error(e);
		} finally {
			busy = false;
		}
	}

	function askMsg(a) {
		if (!a) return '';
		const who = Number(a.asker) === Number(myUid) ? 'You' : nameOf(a.asker);
		const of = Number(a.target) === Number(myUid) ? 'you' : nameOf(a.target);
		if (a.got === 'fish') return `${who} asked ${of} for ${rankLabel(a.rank)}s — Go Fish! 🐟`;
		return `${who} asked ${of} for ${rankLabel(a.rank)}s — took ${a.got}`;
	}

	const winner = $derived.by(() => {
		if (game.result !== 'done') return null;
		const top = Math.max(0, ...game.players.map((u) => game.books?.[u]?.length ?? 0));
		return game.players.filter((u) => (game.books?.[u]?.length ?? 0) === top).map(Number);
	});
</script>

{#if game.result === 'done'}
	<p class="verdict" class:won={winner?.includes(Number(myUid))}>
		🏆 {winner?.map(nameOf).join(' & ')} win{winner?.length === 1 ? 's' : ''} with the most books
	</p>
{/if}

{#if game.lastAsk}<p class="lastask">{askMsg(game.lastAsk)}</p>{/if}

<div class="rivals">
	{#each rivals as r (r.uid)}
		<button
			class="rival"
			class:sel={target === r.uid}
			class:active={Number(game.players[game.turnIdx]) === r.uid}
			disabled={!myTurn}
			onclick={() => (target = r.uid)}
		>
			<span class="rname">{r.name}</span>
			<span class="fan">
				{#each Array(Math.min(r.count, 7)) as _, i (i)}<PlayingCard faceDown small />{/each}
			</span>
			<span class="meta">{r.count} cards · 📚 {r.books}</span>
		</button>
	{/each}
</div>

<p class="turn-note">
	Ocean: {game.oceanCount} · You have 📚 {myBooks}
	· {myTurn ? (target == null ? 'Pick a player to ask' : `Ask ${nameOf(target)} for a rank`) : `Waiting for ${nameOf(game.players[game.turnIdx])}…`}
</p>

{#if myTurn}
	<div class="ranks">
		{#each myRanks as r (r)}
			<button class="rank-btn" disabled={target == null || busy} onclick={() => ask(r)}>{rankLabel(r)}</button>
		{/each}
	</div>
{/if}

<div class="my-hand fan">
	{#each myHand as card (`${card.r}-${card.s}`)}<PlayingCard {card} small />{/each}
</div>

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
	.lastask {
		text-align: center;
		font-size: 13px;
		color: var(--text-dim);
		margin: 0 0 10px;
	}
	.rivals {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 12px;
		margin-bottom: 12px;
	}
	.rival {
		text-align: center;
		padding: 8px 10px;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--surface);
		cursor: pointer;
	}
	.rival:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.rival.sel {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent);
	}
	.rival.active {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.rname {
		display: block;
		font-weight: 600;
		font-size: 14px;
	}
	.fan {
		display: inline-flex;
	}
	.fan :global(.card:not(:first-child)) {
		margin-left: -18px;
	}
	.meta {
		display: block;
		font-size: 12px;
		color: var(--text-dim);
	}
	.turn-note {
		text-align: center;
		font-size: 13px;
		color: var(--text-dim);
	}
	.ranks {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 6px;
		margin-bottom: 12px;
	}
	.rank-btn {
		min-width: 40px;
		height: 40px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
		font-weight: 700;
		cursor: pointer;
	}
	.rank-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.my-hand {
		flex-wrap: wrap;
		justify-content: center;
		row-gap: 6px;
		margin-top: 8px;
	}
</style>

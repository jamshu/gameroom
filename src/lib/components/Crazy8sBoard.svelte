<script>
	// Multiplayer Crazy Eights. `game` is already the per-session view: my hand in
	// full, every rival hand as a count, the stock as a count. All legality is
	// re-checked on the server (playCard) — this only greys illegal cards so the
	// table reads right; a client that posts anyway is refused.
	import PlayingCard from './PlayingCard.svelte';
	import { SUITS } from '$lib/shared/cards.js';
	import { playMove, playCapture, arm } from '$lib/sound.js';

	let { store, game, members, myUid } = $props();

	const nameOf = (uid) =>
		members?.find((m) => Number(m.uid) === Number(uid))?.name || `Player ${uid}`;

	const myHand = $derived(Array.isArray(game.hands?.[myUid]) ? game.hands[myUid] : []);
	const myTurn = $derived(Number(game.players[game.turnIdx]) === Number(myUid) && !game.result);
	const top = $derived(game.discardTop);

	const isLegal = (c) => c.r === 8 || c.s === game.activeSuit || c.r === top?.r;

	const rivals = $derived(
		game.players
			.filter((u) => Number(u) !== Number(myUid))
			.map((u) => ({
				uid: Number(u),
				name: nameOf(u),
				count: game.hands?.[u]?.count ?? 0,
				turn: Number(game.players[game.turnIdx]) === Number(u)
			}))
	);

	let pendingEight = $state(null); // the 8 awaiting a suit choice
	let busy = $state(false);

	async function play(card, suit) {
		if (busy) return;
		busy = true;
		try {
			arm();
			await store.post('crazy8s/play', { card, suit });
			playMove();
			pendingEight = null;
		} catch (e) {
			console.error(e);
		} finally {
			busy = false;
		}
	}

	function clickCard(card) {
		if (!myTurn || busy || !isLegal(card)) return;
		if (card.r === 8) pendingEight = card; // choose a suit first
		else play(card);
	}

	async function draw() {
		if (busy || !myTurn) return;
		busy = true;
		try {
			arm();
			await store.post('crazy8s/draw', {});
			playCapture();
		} catch (e) {
			console.error(e);
		} finally {
			busy = false;
		}
	}
</script>

{#if game.result}
	<p class="verdict" class:won={Number(game.result) === Number(myUid)}>
		{Number(game.result) === Number(myUid) ? '🏆 You went out first!' : `${nameOf(game.result)} went out first`}
	</p>
{/if}

<div class="rivals">
	{#each rivals as r (r.uid)}
		<div class="rival" class:active={r.turn}>
			<span class="rname">{r.name}</span>
			<span class="fan">
				{#each Array(Math.min(r.count, 8)) as _, i (i)}
					<PlayingCard faceDown small />
				{/each}
			</span>
			<span class="count">{r.count} card{r.count === 1 ? '' : 's'}</span>
		</div>
	{/each}
</div>

<div class="table">
	<button class="pile stock" onclick={draw} disabled={!myTurn || busy} title="Draw a card">
		<PlayingCard faceDown />
		<span class="pile-label">Draw ({game.stockCount})</span>
	</button>
	<div class="pile discard">
		{#if top}<PlayingCard card={top} />{/if}
		<span class="pile-label">Suit: {SUITS[game.activeSuit]}</span>
	</div>
</div>

{#if pendingEight}
	<div class="suit-pick">
		<span>Name a suit:</span>
		{#each SUITS as glyph, s (s)}
			<button class="suit-btn" onclick={() => play(pendingEight, s)} disabled={busy}>{glyph}</button>
		{/each}
		<button class="suit-btn cancel" onclick={() => (pendingEight = null)}>✕</button>
	</div>
{/if}

<div class="my-hand">
	<p class="turn-note">{myTurn ? 'Your turn — play a match or draw' : `Waiting for ${nameOf(game.players[game.turnIdx])}…`}</p>
	<div class="fan hand">
		{#each myHand as card (`${card.r}-${card.s}`)}
			<PlayingCard {card} selectable={myTurn && isLegal(card)} onclick={clickCard} />
		{/each}
	</div>
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
	.rivals {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 16px;
		margin-bottom: 16px;
	}
	.rival {
		text-align: center;
		padding: 6px 10px;
		border-radius: 10px;
		border: 1px solid transparent;
	}
	.rival.active {
		border-color: var(--accent);
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
		margin-left: -22px;
	}
	.fan.hand :global(.card:not(:first-child)) {
		margin-left: -14px;
	}
	.count {
		display: block;
		font-size: 12px;
		color: var(--text-dim);
	}
	.table {
		display: flex;
		justify-content: center;
		gap: 40px;
		margin: 10px 0 18px;
	}
	.pile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		cursor: pointer;
	}
	.pile.stock:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.pile-label {
		font-size: 12px;
		color: var(--text-dim);
	}
	.suit-pick {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin-bottom: 14px;
	}
	.suit-btn {
		font-size: 22px;
		width: 44px;
		height: 44px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
		cursor: pointer;
	}
	.suit-btn.cancel {
		font-size: 16px;
	}
	.my-hand {
		text-align: center;
	}
	.turn-note {
		font-size: 13px;
		color: var(--text-dim);
		margin: 0 0 8px;
	}
	.fan.hand {
		flex-wrap: wrap;
		justify-content: center;
		row-gap: 6px;
	}
</style>

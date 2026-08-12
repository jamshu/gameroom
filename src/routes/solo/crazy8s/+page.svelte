<script>
	// Solo Crazy Eights — entirely local, offline-capable (the /solo prefix is
	// precached). Same rules module the room uses; the only addition is a greedy
	// bot for the single opponent. You are player 0, the bot is player 1.
	//
	// ponytail: the bot picks the first legal card (wilds last) with no lookahead —
	// a casual opponent, not a solver. Swap in a smarter policy here if it ever matters.
	import PlayingCard from '$lib/components/PlayingCard.svelte';
	import { SUITS } from '$lib/shared/cards.js';
	import { initCrazy8s, playCard, drawCard, legalPlays, topCard } from '$lib/shared/crazy8s.js';
	import { getBest, recordBest } from '$lib/solo-bests.js';
	import { playMove, playCapture, arm } from '$lib/sound.js';

	const YOU = 0;
	const BOT = 1;

	let game = $state(newGameObj());
	let pendingEight = $state(null);
	let thinking = $state(false);
	let streak = $state(0);
	let best = $state(getBest('crazy8s'));
	let message = $state('');

	function newGameObj() {
		return initCrazy8s([YOU, BOT]);
	}
	function newGame() {
		game = newGameObj();
		pendingEight = null;
		message = '';
	}

	const myHand = $derived(game.hands[YOU]);
	const top = $derived(topCard(game));
	const myTurn = $derived(game.players[game.turnIdx] === YOU && game.result == null);
	const isLegal = (c) => c.r === 8 || c.s === game.activeSuit || c.r === top?.r;

	function afterMove() {
		if (game.result != null) return endGame();
		if (game.players[game.turnIdx] === BOT) runBot();
	}

	function play(card, suit) {
		playCard(game, YOU, card, suit);
		playMove();
		pendingEight = null;
		afterMove();
	}
	function clickCard(card) {
		if (!myTurn || thinking || !isLegal(card)) return;
		if (card.r === 8) pendingEight = card;
		else play(card);
	}
	function draw() {
		if (!myTurn || thinking) return;
		drawCard(game, YOU);
		playCapture();
		afterMove();
	}

	function botOnce() {
		const hand = game.hands[BOT];
		const legal = legalPlays(hand, game.activeSuit, top.r);
		// non-8s first so the bot keeps its wilds
		const pick = legal.find((c) => c.r !== 8) ?? legal[0];
		if (pick) {
			const suit = pick.r === 8 ? mostSuit(hand) : undefined;
			playCard(game, BOT, pick, suit);
		} else {
			drawCard(game, BOT);
		}
	}
	function mostSuit(hand) {
		const c = [0, 0, 0, 0];
		for (const card of hand) if (card.r !== 8) c[card.s]++;
		return c.indexOf(Math.max(...c));
	}

	async function runBot() {
		thinking = true;
		// one step at a time with a beat, so a chain of bot draws is watchable
		while (game.players[game.turnIdx] === BOT && game.result == null) {
			await new Promise((r) => setTimeout(r, 550));
			botOnce();
			playMove();
		}
		thinking = false;
		if (game.result != null) endGame();
	}

	function endGame() {
		const youWon = game.result === YOU;
		streak = youWon ? streak + 1 : 0;
		message = youWon ? '🏆 You went out first!' : '🤖 The bot went out first.';
		if (youWon) {
			const res = recordBest('crazy8s', null, streak);
			best = res.best;
		}
	}

	arm();
</script>

<svelte:head><title>Solo Crazy Eights · Gamerooms</title></svelte:head>

<div class="fade-in solo">
	<header class="solo-head">
		<a class="btn btn--ghost btn--sm" href="/" aria-label="Back">←</a>
		<h1 class="title">🃏 Crazy Eights</h1>
		<button class="btn btn--ghost btn--sm" onclick={newGame}>New</button>
	</header>

	<p class="streak">Win streak: <strong>{streak}</strong>{#if best} · best <strong>{best.value}</strong>{/if}</p>

	<div class="bot-row">
		<span class="label">Bot</span>
		<span class="fan">
			{#each Array(Math.min(game.hands[BOT].length, 10)) as _, i (i)}<PlayingCard faceDown small />{/each}
		</span>
		<span class="count">{game.hands[BOT].length}</span>
	</div>

	<div class="table">
		<button class="pile" onclick={draw} disabled={!myTurn || thinking} title="Draw">
			<PlayingCard faceDown />
			<span class="pile-label">Draw ({game.stock.length})</span>
		</button>
		<div class="pile">
			<PlayingCard card={top} />
			<span class="pile-label">Suit {SUITS[game.activeSuit]}</span>
		</div>
	</div>

	{#if message}<p class="verdict" class:won={game.result === YOU}>{message}</p>{/if}

	{#if pendingEight}
		<div class="suit-pick">
			<span>Name a suit:</span>
			{#each SUITS as glyph, s (s)}
				<button class="suit-btn" onclick={() => play(pendingEight, s)}>{glyph}</button>
			{/each}
			<button class="suit-btn" onclick={() => (pendingEight = null)}>✕</button>
		</div>
	{/if}

	<p class="turn-note">{game.result != null ? '' : myTurn ? 'Your turn' : 'Bot thinking…'}</p>
	<div class="fan hand">
		{#each myHand as card (`${card.r}-${card.s}`)}
			<PlayingCard {card} selectable={myTurn && isLegal(card)} onclick={clickCard} />
		{/each}
	</div>
</div>

<style>
	.solo {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding-bottom: 24px;
		max-width: 640px;
		margin: 0 auto;
	}
	.solo-head {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
	}
	.title {
		margin: 0;
		font-size: 1.25rem;
		flex: 1;
		text-align: center;
	}
	.streak {
		font-size: 13px;
		color: var(--text-dim);
		margin: 0;
	}
	.bot-row {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.label {
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
		font-size: 12px;
		color: var(--text-dim);
	}
	.table {
		display: flex;
		gap: 40px;
		margin: 6px 0;
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
	.pile:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.pile-label {
		font-size: 12px;
		color: var(--text-dim);
	}
	.verdict {
		font-weight: 700;
		color: var(--text-dim);
		margin: 4px 0;
	}
	.verdict.won {
		color: var(--accent);
	}
	.suit-pick {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.suit-btn {
		font-size: 20px;
		width: 42px;
		height: 42px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
		cursor: pointer;
	}
	.turn-note {
		font-size: 13px;
		color: var(--text-dim);
		margin: 0;
		min-height: 1em;
	}
	.fan.hand {
		flex-wrap: wrap;
		justify-content: center;
		row-gap: 6px;
	}
</style>

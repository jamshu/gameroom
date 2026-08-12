<script>
	// Solo Go Fish — local, offline. Same rules module as the room; the opponent is
	// a greedy bot. You are player 0, the bot is player 1.
	//
	// ponytail: the bot asks you for a random rank it holds, with no memory of your
	// past asks — a casual opponent. Give it card-counting memory here if it matters.
	import PlayingCard from '$lib/components/PlayingCard.svelte';
	import { rankLabel } from '$lib/shared/cards.js';
	import { initGoFish, ask, handRanks } from '$lib/shared/gofish.js';
	import { getBest, recordBest } from '$lib/solo-bests.js';
	import { playMove, playCapture, arm } from '$lib/sound.js';

	const YOU = 0;
	const BOT = 1;

	let game = $state(initGoFish([YOU, BOT]));
	let thinking = $state(false);
	let best = $state(getBest('gofish'));
	let recorded = $state(false);

	const myHand = $derived(game.hands[YOU]);
	const myRanks = $derived([...new Set(myHand.map((c) => c.r))].sort((a, b) => a - b));
	const myTurn = $derived(game.players[game.turnIdx] === YOU && game.result == null);
	const done = $derived(game.result === 'done');

	function newGame() {
		game = initGoFish([YOU, BOT]);
		thinking = false;
		recorded = false;
	}

	function askRank(rank) {
		if (!myTurn || thinking) return;
		const res = ask(game, YOU, BOT, rank);
		res.result.got === 'fish' ? playCapture() : playMove();
		after();
	}

	function after() {
		if (game.result === 'done') return finish();
		if (game.players[game.turnIdx] === BOT) runBot();
	}

	function botOnce() {
		const ranks = handRanks(game.hands[BOT]);
		if (ranks.length === 0) return false;
		const rank = ranks[Math.floor(Math.random() * ranks.length)];
		const res = ask(game, BOT, YOU, rank);
		return res.keepTurn && game.result == null;
	}

	async function runBot() {
		thinking = true;
		while (game.players[game.turnIdx] === BOT && game.result == null) {
			await new Promise((r) => setTimeout(r, 650));
			const again = botOnce();
			playMove();
			if (!again) break;
		}
		thinking = false;
		if (game.result === 'done') finish();
	}

	function finish() {
		if (recorded) return;
		recorded = true;
		const mine = game.books[YOU].length;
		best = recordBest('gofish', null, mine).best;
	}

	const nameOf = (uid) => (Number(uid) === YOU ? 'You' : 'Bot');
	function askMsg(a) {
		if (!a) return '';
		if (a.got === 'fish') return `${nameOf(a.asker)} asked ${nameOf(a.target)} for ${rankLabel(a.rank)}s — Go Fish! 🐟`;
		return `${nameOf(a.asker)} asked ${nameOf(a.target)} for ${rankLabel(a.rank)}s — took ${a.got}`;
	}

	arm();
</script>

<svelte:head><title>Solo Go Fish · Gamerooms</title></svelte:head>

<div class="fade-in solo">
	<header class="solo-head">
		<a class="btn btn--ghost btn--sm" href="/" aria-label="Back">←</a>
		<h1 class="title">🐟 Go Fish</h1>
		<button class="btn btn--ghost btn--sm" onclick={newGame}>New</button>
	</header>

	<p class="streak">
		📚 You {game.books[YOU].length} · Bot {game.books[BOT].length} · Ocean {game.ocean.length}
		{#if best} · best {best.value}{/if}
	</p>

	{#if game.lastAsk}<p class="lastask">{askMsg(game.lastAsk)}</p>{/if}

	{#if done}
		{@const won = game.books[YOU].length > game.books[BOT].length}
		{@const tie = game.books[YOU].length === game.books[BOT].length}
		<p class="verdict" class:won>{tie ? "🤝 It's a tie!" : won ? '🏆 You win with the most books!' : '🤖 Bot wins.'}</p>
		<button class="btn btn--primary" onclick={newGame}>Play again</button>
	{/if}

	<div class="bot-row">
		<span class="label">Bot · {game.hands[BOT].length} cards</span>
		<span class="fan">
			{#each Array(Math.min(game.hands[BOT].length, 9)) as _, i (i)}<PlayingCard faceDown small />{/each}
		</span>
	</div>

	<p class="turn-note">{done ? '' : myTurn ? 'Ask the bot for a rank you hold:' : 'Bot thinking…'}</p>
	{#if myTurn}
		<div class="ranks">
			{#each myRanks as r (r)}<button class="rank-btn" onclick={() => askRank(r)}>{rankLabel(r)}</button>{/each}
		</div>
	{/if}

	<div class="fan hand">
		{#each myHand as card (`${card.r}-${card.s}`)}<PlayingCard {card} small />{/each}
	</div>
</div>

<style>
	.solo {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		max-width: 640px;
		margin: 0 auto;
		padding-bottom: 24px;
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
	.lastask {
		font-size: 13px;
		color: var(--text-dim);
		margin: 0;
		text-align: center;
	}
	.verdict {
		font-weight: 700;
		color: var(--text-dim);
		margin: 0;
	}
	.verdict.won {
		color: var(--accent);
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
		margin-left: -18px;
	}
	.turn-note {
		font-size: 13px;
		color: var(--text-dim);
		margin: 0;
		min-height: 1em;
	}
	.ranks {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 6px;
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
	.fan.hand {
		flex-wrap: wrap;
		justify-content: center;
		row-gap: 6px;
	}
</style>

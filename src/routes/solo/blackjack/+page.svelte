<script>
	// Solo Blackjack — local, offline. Same rules module as the room; the "opponent"
	// is the dealer, whose play is a fixed rule inside blackjack.js (hit < 17), so
	// there is no bot to write. You are the only player. Tracks a win streak.
	import PlayingCard from '$lib/components/PlayingCard.svelte';
	import { initBlackjack, hit, stand, handValue } from '$lib/shared/blackjack.js';
	import { getBest, recordBest } from '$lib/solo-bests.js';
	import { playMove, playCapture, arm } from '$lib/sound.js';

	const YOU = 0;

	let game = $state(initBlackjack([YOU]));
	let streak = $state(0);
	let best = $state(getBest('blackjack'));

	const done = $derived(game.phase === 'done');
	const myTotal = $derived(handValue(game.hands[YOU]));
	const dealerShown = $derived(
		done ? handValue(game.dealer) : handValue([game.dealer[0]])
	);

	function newGame() {
		game = initBlackjack([YOU]);
	}
	function settleIfDone() {
		if (game.phase !== 'done') return;
		const won = game.outcomes[YOU] === 'win';
		streak = won ? streak + 1 : 0;
		if (won) best = recordBest('blackjack', null, streak).best;
	}
	function doHit() {
		if (done) return;
		hit(game, YOU);
		playCapture();
		settleIfDone();
	}
	function doStand() {
		if (done) return;
		stand(game, YOU);
		playMove();
		settleIfDone();
	}

	const outcomeLabel = { win: '✅ You win', lose: '❌ You lose', push: '➖ Push' };
	arm();
</script>

<svelte:head><title>Solo Blackjack · Gamerooms</title></svelte:head>

<div class="fade-in solo">
	<header class="solo-head">
		<a class="btn btn--ghost btn--sm" href="/" aria-label="Back">←</a>
		<h1 class="title">🎰 Blackjack</h1>
		<button class="btn btn--ghost btn--sm" onclick={newGame}>New</button>
	</header>

	<p class="streak">Win streak: <strong>{streak}</strong>{#if best} · best <strong>{best.value}</strong>{/if}</p>

	<section class="area">
		<h3>Dealer <span class="tot">{done ? dealerShown.total + (dealerShown.bust ? ' bust' : '') : dealerShown.total + '+?'}</span></h3>
		<div class="hand">
			{#each game.dealer as card, i (i)}
				<PlayingCard card={!done && i === 1 ? null : card} faceDown={!done && i === 1} />
			{/each}
		</div>
	</section>

	<section class="area">
		<h3>You <span class="tot">{myTotal.total}{myTotal.bust ? ' bust' : ''}</span></h3>
		<div class="hand">
			{#each game.hands[YOU] as card, i (i)}<PlayingCard {card} />{/each}
		</div>
	</section>

	{#if done}
		<p class="verdict" class:won={game.outcomes[YOU] === 'win'}>{outcomeLabel[game.outcomes[YOU]]}</p>
		<button class="btn btn--primary" onclick={newGame}>Deal again</button>
	{:else}
		<div class="controls">
			<button class="btn btn--primary" onclick={doHit}>Hit</button>
			<button class="btn" onclick={doStand}>Stand</button>
		</div>
	{/if}
</div>

<style>
	.solo {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		max-width: 520px;
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
	.area {
		text-align: center;
	}
	.area h3 {
		margin: 0 0 8px;
	}
	.tot {
		font-weight: 500;
		font-size: 14px;
		color: var(--text-dim);
	}
	.hand {
		display: inline-flex;
		gap: 5px;
		justify-content: center;
	}
	.verdict {
		font-weight: 700;
		color: var(--text-dim);
		margin: 0;
	}
	.verdict.won {
		color: var(--accent);
	}
	.controls {
		display: flex;
		gap: 12px;
	}
</style>

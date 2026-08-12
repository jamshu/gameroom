<script>
	// Multiplayer Blackjack (no money). `game` is the per-session view: every up-card
	// is public, the dealer's hole card is masked until the round is done. Totals are
	// computed server-side and carried on the view, so the client never miscounts.
	import PlayingCard from './PlayingCard.svelte';
	import { playMove, playCapture, arm } from '$lib/sound.js';

	let { store, game, members, myUid } = $props();

	const nameOf = (uid) =>
		members?.find((m) => Number(m.uid) === Number(uid))?.name || `Player ${uid}`;

	const myTurn = $derived(
		Number(game.players[game.turnIdx]) === Number(myUid) && game.phase === 'playing'
	);
	const done = $derived(game.phase === 'done');
	let busy = $state(false);

	async function act(move) {
		if (busy || !myTurn) return;
		busy = true;
		try {
			arm();
			await store.post(`blackjack/${move}`, {});
			move === 'hit' ? playCapture() : playMove();
		} catch (e) {
			console.error(e);
		} finally {
			busy = false;
		}
	}

	const outcomeLabel = { win: '✅ Win', lose: '❌ Lose', push: '➖ Push' };
</script>

<div class="dealer">
	<h3>Dealer {#if done}<span class="tot">({game.dealer.total}{game.dealer.bust ? ' — bust' : ''})</span>{:else}<span class="tot">({game.dealer.up}+?)</span>{/if}</h3>
	<div class="hand">
		{#each game.dealer.cards as card, i (i)}
			<PlayingCard card={card.hidden ? null : card} faceDown={!!card.hidden} />
		{/each}
	</div>
</div>

<div class="seats">
	{#each game.players as uid (uid)}
		{@const h = game.hands[uid]}
		{@const isMe = Number(uid) === Number(myUid)}
		{@const isTurn = Number(game.players[game.turnIdx]) === Number(uid) && game.phase === 'playing'}
		<div class="seat" class:me={isMe} class:active={isTurn}>
			<div class="seat-head">
				<span class="pname">{isMe ? 'You' : nameOf(uid)}</span>
				<span class="tot">{h.total}{h.bust ? ' bust' : ''}</span>
			</div>
			<div class="hand">
				{#each h.cards as card, i (i)}<PlayingCard {card} small />{/each}
			</div>
			{#if done}
				<span class="outcome">{outcomeLabel[game.outcomes?.[uid]] ?? ''}</span>
			{:else if game.busted[uid]}
				<span class="state">bust</span>
			{:else if game.standing[uid]}
				<span class="state">stands</span>
			{:else if isTurn}
				<span class="state turn">acting…</span>
			{/if}
		</div>
	{/each}
</div>

{#if myTurn}
	<div class="controls">
		<button class="btn btn--primary" onclick={() => act('hit')} disabled={busy}>Hit</button>
		<button class="btn" onclick={() => act('stand')} disabled={busy}>Stand</button>
	</div>
{:else if !done}
	<p class="turn-note">Waiting for {nameOf(game.players[game.turnIdx])}…</p>
{:else}
	<p class="turn-note">Round over — {game.dealer.bust ? 'dealer busts' : `dealer has ${game.dealer.total}`}.</p>
{/if}

<style>
	.dealer,
	.seat {
		text-align: center;
	}
	.dealer h3 {
		margin: 0 0 8px;
	}
	.tot {
		color: var(--text-dim);
		font-weight: 500;
		font-size: 14px;
	}
	.hand {
		display: inline-flex;
		gap: 4px;
		justify-content: center;
	}
	.seats {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 14px;
		margin: 20px 0;
	}
	.seat {
		padding: 10px;
		border-radius: 10px;
		border: 1px solid var(--border);
		min-width: 120px;
	}
	.seat.me {
		border-color: var(--accent);
	}
	.seat.active {
		box-shadow: 0 0 0 2px var(--accent);
	}
	.seat-head {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 6px;
		font-size: 14px;
	}
	.pname {
		font-weight: 600;
	}
	.outcome,
	.state {
		display: block;
		margin-top: 6px;
		font-size: 13px;
		color: var(--text-dim);
	}
	.state.turn {
		color: var(--accent);
	}
	.controls {
		display: flex;
		justify-content: center;
		gap: 12px;
	}
	.turn-note {
		text-align: center;
		color: var(--text-dim);
		font-size: 13px;
	}
</style>

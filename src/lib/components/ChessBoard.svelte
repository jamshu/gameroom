<script>
	import { Chess } from 'chess.js';
	import Avatar from './Avatar.svelte';

	let { store, game, members, myUid } = $props();
	let selected = $state(null); // square like 'e2'
	let error = $state('');

	const chess = $derived(new Chess(game.fen));
	const myColor = $derived(game.players.w === myUid ? 'w' : game.players.b === myUid ? 'b' : null);
	const myTurn = $derived(myColor && chess.turn() === myColor && !game.result);
	const nameOf = $derived((uid) => members.find((m) => m.uid === uid)?.name || `#${uid}`);

	const PIECES = {
		wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
		bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚'
	};

	const FILES = 'abcdefgh';
	// black player sees the board flipped
	const squares = $derived.by(() => {
		const board = chess.board(); // ranks 8..1
		const out = [];
		for (let r = 0; r < 8; r++) {
			for (let f = 0; f < 8; f++) {
				const rr = myColor === 'b' ? 7 - r : r;
				const ff = myColor === 'b' ? 7 - f : f;
				const piece = board[rr][ff];
				out.push({
					sq: FILES[ff] + (8 - rr),
					piece: piece ? PIECES[piece.color + piece.type] : '',
					dark: (rr + ff) % 2 === 1
				});
			}
		}
		return out;
	});

	const legalTargets = $derived(
		selected ? chess.moves({ square: selected, verbose: true }).map((m) => m.to) : []
	);

	async function tap(sq) {
		error = '';
		if (!myTurn) return;
		if (selected && legalTargets.includes(sq)) {
			const from = selected;
			selected = null;
			try {
				await store.post('chess/move', { from, to: sq });
			} catch (e) {
				error = e.message;
			}
			return;
		}
		const piece = chess.get(sq);
		selected = piece && piece.color === myColor ? sq : null;
	}
</script>

<div class="card" style="padding:20px;">
	<div class="chess-head">
		<span><Avatar uid={game.players.w} name={nameOf(game.players.w)} size={24} /> {nameOf(game.players.w)} ♔</span>
		<span class="muted">vs</span>
		<span>♚ {nameOf(game.players.b)} <Avatar uid={game.players.b} name={nameOf(game.players.b)} size={24} /></span>
	</div>

	{#if game.result}
		<p class="chip chip--green" style="margin-bottom:10px;">
			{game.result === 'draw' ? 'Draw!' : `${nameOf(game.players[game.result])} wins! 🏆`}
		</p>
	{:else}
		<p class="muted" style="margin-bottom:10px;">
			{myColor
				? myTurn
					? 'Your move'
					: `Waiting for ${nameOf(chess.turn() === 'w' ? game.players.w : game.players.b)}…`
				: `Spectating — ${nameOf(chess.turn() === 'w' ? game.players.w : game.players.b)} to move`}
		</p>
	{/if}
	{#if error}<p class="error-text">{error}</p>{/if}

	<div class="board">
		{#each squares as s (s.sq)}
			<button
				class="sq {s.dark ? 'sq--dark' : ''} {selected === s.sq ? 'sq--sel' : ''} {legalTargets.includes(s.sq) ? 'sq--hint' : ''}"
				onclick={() => tap(s.sq)}
			>{s.piece}</button>
		{/each}
	</div>

	{#if game.moves.length}
		<p class="muted moves">{game.moves.join(' ')}</p>
	{/if}
</div>

<style>
	.chess-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	.chess-head span {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.board {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		aspect-ratio: 1;
		max-width: 480px;
		border: 2px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.sq {
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: clamp(20px, 5.5vw, 34px);
		background: #e8d5b0;
		border: none;
		cursor: pointer;
		padding: 0;
		line-height: 1;
	}
	.sq--dark {
		background: #a06c3c;
	}
	.sq--sel {
		outline: 3px solid var(--accent);
		outline-offset: -3px;
	}
	.sq--hint {
		box-shadow: inset 0 0 0 100px rgba(124, 58, 237, 0.28);
	}
	.moves {
		margin-top: 10px;
		font-size: 0.8rem;
		word-break: break-word;
	}
</style>

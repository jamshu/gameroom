<script>
	import { Chess } from 'chess.js';
	import Avatar from './Avatar.svelte';

	let { store, game, members, myUid } = $props();
	let selected = $state(null); // square like 'e2'
	let error = $state('');
	// own move applied locally before the server confirms — kills the POST+poll lag
	let optimisticFen = $state(null);

	// server state invalidates any optimistic view as soon as it arrives
	$effect(() => {
		game.fen;
		optimisticFen = null;
	});

	const fen = $derived(optimisticFen ?? game.fen);
	const chess = $derived(new Chess(fen));
	const myColor = $derived(game.players.w === myUid ? 'w' : game.players.b === myUid ? 'b' : null);
	const myTurn = $derived(myColor && chess.turn() === myColor && !game.result && !optimisticFen);
	const nameOf = $derived((uid) => members.find((m) => m.uid === uid)?.name || `#${uid}`);

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
					img: piece ? `/pieces/${piece.color}${piece.type.toUpperCase()}.svg` : null,
					label: piece ? `${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : '',
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
			// optimistic: move renders instantly, server confirms via poll
			const local = new Chess(fen);
			try {
				local.move({ from, to: sq, promotion: 'q' });
				optimisticFen = local.fen();
			} catch {
				return;
			}
			try {
				await store.post('chess/move', { from, to: sq });
			} catch (e) {
				optimisticFen = null; // rollback — server rejected
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
		<span><Avatar uid={game.players.w} name={nameOf(game.players.w)} size={24} /> {nameOf(game.players.w)} <img class="mini" src="/pieces/wK.svg" alt="white" /></span>
		<span class="muted">vs</span>
		<span><img class="mini" src="/pieces/bK.svg" alt="black" /> {nameOf(game.players.b)} <Avatar uid={game.players.b} name={nameOf(game.players.b)} size={24} /></span>
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
					: optimisticFen
						? 'Sending…'
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
			>
				{#if s.img}<img class="piece" src={s.img} alt={s.label} draggable="false" />{/if}
			</button>
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
	.mini {
		width: 22px;
		height: 22px;
	}
	.board {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		aspect-ratio: 1;
		max-width: 520px;
		border: 2px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.sq {
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #ebecd0;
		border: none;
		cursor: pointer;
		padding: 0;
	}
	.sq--dark {
		background: #779556;
	}
	.piece {
		width: 88%;
		height: 88%;
		pointer-events: none;
		user-select: none;
	}
	.sq--sel {
		background: #f5f682;
	}
	.sq--dark.sq--sel {
		background: #b9ca43;
	}
	.sq--hint {
		box-shadow: inset 0 0 0 100px rgba(0, 0, 0, 0.14);
	}
	.sq--hint:not(:has(.piece))::after {
		content: '';
		width: 30%;
		height: 30%;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.22);
	}
	.moves {
		margin-top: 10px;
		font-size: 0.8rem;
		word-break: break-word;
	}
</style>

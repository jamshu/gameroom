<script>
	// Solo chess — you vs Stockfish, entirely local. No room, no Durable Object,
	// no Odoo: the board is driven in the tab and the engine (the same WASM the
	// premium room hint uses) plays the other side.
	//
	// It reuses the multiplayer ChessBoard verbatim by handing it the same shape
	// the room does — a `game` object and a `store.post()` — but resolved locally.
	// The one thing it can't do offline is the FIRST move: Stockfish's WASM lives
	// at /engine, not under /solo, so it downloads on demand like the room hint.
	import { onDestroy } from 'svelte';
	import { Chess } from 'chess.js';
	import ChessBoard from '$lib/components/ChessBoard.svelte';
	import { createChessEngine } from '$lib/chessengine.svelte.js';
	import { user } from '$lib/stores/auth.js';

	const YOU = 1;
	const AI = 2;
	const START = new Chess().fen();
	const MIN_THINK_MS = 2000; // floor on the engine's reply so it doesn't snap back

	// Skill Level (0..20) + search depth per tier. Easy is genuinely beatable;
	// Hard is far past club strength. See chessengine.bestMove.
	const LEVELS = [
		{ id: 'easy', label: 'Easy', skill: 2, depth: 6 },
		{ id: 'medium', label: 'Medium', skill: 8, depth: 10 },
		{ id: 'hard', label: 'Hard', skill: 18, depth: 14 }
	];

	let level = $state('medium');
	let myColor = $state('w'); // your side; the AI takes the other
	let game = $state(null);
	let thinking = $state(false); // the engine is computing its reply
	let error = $state('');

	// premium post-game review
	let reviewData = $state(null);
	let reviewing = $state(false);
	let reviewDone = $state(0);
	let reviewTotal = $state(0);

	const opts = $derived(LEVELS.find((l) => l.id === level) ?? LEVELS[1]);
	const isPremium = $derived(!!$user?.premium);
	const members = $derived([
		{ uid: YOU, name: 'You' },
		{ uid: AI, name: `DashaMoolam · ${opts.label}` }
	]);

	const engine = createChessEngine();
	onDestroy(() => engine.dispose());

	function newGame() {
		error = '';
		reviewData = null;
		reviewing = false;
		const players = myColor === 'w' ? { w: YOU, b: AI } : { w: AI, b: YOU };
		game = {
			fen: START,
			moves: [],
			result: null,
			endReason: null,
			players,
			clock: null,
			drawOffer: null,
			v: 0
		};
		if (players.w === AI) aiMove(); // the engine opens when you take black
	}

	/** Mirror the server's specific-first draw/mate detection (chess/move endpoint). */
	function applyResult(chess, moverColor) {
		if (chess.isCheckmate()) {
			game.result = moverColor;
			game.endReason = 'checkmate';
		} else if (chess.isStalemate()) {
			game.result = 'draw';
			game.endReason = 'stalemate';
		} else if (chess.isThreefoldRepetition()) {
			game.result = 'draw';
			game.endReason = 'repetition';
		} else if (chess.isInsufficientMaterial()) {
			game.result = 'draw';
			game.endReason = 'insufficient';
		} else if (chess.isDraw()) {
			game.result = 'draw';
			game.endReason = 'fifty-move';
		}
	}

	async function aiMove() {
		if (!game || game.result) return;
		const aiColor = game.players.w === AI ? 'w' : 'b';
		const from = game.fen;
		const c = new Chess(from);
		if (c.turn() !== aiColor) return;
		thinking = true;
		error = '';
		try {
			const start = Date.now();
			const best = await engine.bestMove(from, { skill: opts.skill, depth: opts.depth });
			// Floor the reply at ~2s: a low-depth search returns almost instantly and
			// an opponent that snaps back before you've let go of your piece feels off.
			const rest = MIN_THINK_MS - (Date.now() - start);
			if (rest > 0) await new Promise((r) => setTimeout(r, rest));
			// a new game (or your move) may have started while it thought/waited
			if (!best || !game || game.result || game.fen !== from) return;
			const mv = c.move({ from: best.from, to: best.to, promotion: 'q' });
			game.fen = c.fen();
			game.moves = [...game.moves, mv.san];
			game.v++;
			applyResult(c, aiColor);
		} catch (e) {
			error = e?.message || 'Could not reach the engine';
		} finally {
			thinking = false;
		}
	}

	// The local stand-in for the room's store: ChessBoard posts here and we resolve
	// it against a chess.js in this tab, then let the engine reply.
	const store = {
		async post(path, body) {
			if (path === 'chess/move') {
				const c = new Chess(game.fen);
				const moverColor = c.turn();
				let mv;
				try {
					mv = c.move({ from: body.from, to: body.to, promotion: body.promotion || 'q' });
				} catch {
					throw new Error('Illegal move');
				}
				game.fen = c.fen();
				game.moves = [...game.moves, mv.san];
				game.v++;
				applyResult(c, moverColor);
				if (!game.result) aiMove(); // fire-and-forget; the board animates the reply
				return { ok: true };
			}
			if (path === 'chess/resign') {
				game.result = game.players.w === AI ? 'w' : 'b'; // the engine wins
				game.endReason = 'resignation';
				game.v++;
				return { ok: true };
			}
			return { ok: true }; // draw/flag have no meaning in solo
		}
	};

	/* ---- premium review ---------------------------------------------------- */

	const cpOf = (r) => (r == null ? null : r.mate != null ? (r.mate > 0 ? 100000 : -100000) : (r.cp ?? 0));
	// Thresholds are loose because eval comes from two separate depth-12 searches:
	// the same move re-searched can wobble tens of cp, so a tight "Best" band would
	// flag top moves as inaccuracies. The playedIsBest short-circuit below is the
	// real guard; this only grades moves that genuinely differ from the engine's.
	function classify(loss) {
		if (loss < 40) return 'Best';
		if (loss < 90) return 'Good';
		if (loss < 150) return 'Inaccuracy';
		if (loss < 300) return 'Mistake';
		return 'Blunder';
	}

	/**
	 * Analyse each position once at full strength, then score every move by how much
	 * eval it gave up versus the best line. `evals[i]` is from the side to move at
	 * position i, so the mover's realised eval after their move is `-evals[i+1]`.
	 */
	async function reviewGame() {
		if (!isPremium || reviewing || !game?.moves.length) return;
		reviewing = true;
		error = '';
		try {
			const c = new Chess();
			const fens = [c.fen()];
			const played = []; // the actual move made from each position, with squares
			for (const san of game.moves) {
				const mv = c.move(san);
				fens.push(c.fen());
				played.push({ from: mv.from, to: mv.to, san });
			}
			reviewTotal = fens.length;
			reviewDone = 0;

			const evals = [];
			const bests = [];
			for (let i = 0; i < fens.length; i++) {
				const r = await engine.analyse(fens[i], 12);
				evals.push(cpOf(r));
				bests.push(r ? { from: r.from, to: r.to, san: r.san } : null);
				reviewDone = i + 1;
			}

			const data = [];
			for (let m = 0; m < game.moves.length; m++) {
				const evBest = evals[m];
				const evAfter = evals[m + 1];
				// If you played the engine's own top move, it's Best — full stop. This is
				// the fix for top moves showing as "Inaccuracy": the cp comparison below
				// is noisy across two searches, but move equality is exact.
				const playedIsBest =
					bests[m] && played[m] && bests[m].from === played[m].from && bests[m].to === played[m].to;
				let tag = 'Good';
				if (playedIsBest || evAfter == null) tag = 'Best';
				else if (evBest != null && evAfter != null) tag = classify(Math.max(0, evBest + evAfter));
				// white moves are the even plies; you are `myColor`
				const byYou = (m % 2 === 0) === (myColor === 'w');
				data[m] = { tag, best: bests[m], played: played[m], playedSan: game.moves[m], byYou };
			}
			reviewData = data;
		} catch (e) {
			error = e?.message || 'Review failed';
		} finally {
			reviewing = false;
		}
	}

	newGame();
</script>

<svelte:head><title>Solo Chess · Gamerooms</title></svelte:head>

<div class="fade-in solo">
	<header class="solo-head">
		<a class="btn btn--ghost btn--sm" href="/" aria-label="Back">←</a>
		<h1 class="title">♟️ Chess</h1>
		<details class="game-menu">
			<summary class="btn btn--ghost btn--sm" title="Difficulty & new game">⚙️ {opts.label}</summary>
			<div class="menu-pop card">
				<span class="menu-label">Difficulty</span>
				<div class="levels" role="radiogroup" aria-label="Difficulty">
					{#each LEVELS as l}
						<button
							type="button"
							class="btn btn--sm"
							class:btn--primary={level === l.id}
							class:btn--ghost={level !== l.id}
							role="radio"
							aria-checked={level === l.id}
							onclick={() => (level = l.id)}
						>
							{l.label}
						</button>
					{/each}
				</div>
				<button
					type="button"
					class="btn btn--ghost btn--sm"
					onclick={() => (myColor = myColor === 'w' ? 'b' : 'w')}
				>
					Play {myColor === 'w' ? '♔ White' : '♚ Black'}
				</button>
				<button type="button" class="btn btn--primary btn--sm" onclick={newGame}>New game</button>
			</div>
		</details>
	</header>

	{#if error}<p class="error-text">{error}</p>{/if}
	{#if thinking && !game.result}<p class="muted">DashaMoolam is thinking…</p>{/if}

	{#if game?.result && isPremium}
		<div class="card review-card">
			{#if reviewing}
				<p class="muted">Analysing your game… {reviewDone}/{reviewTotal}</p>
			{:else if reviewData}
				<p class="muted">
					Playing back your game — <b style="color:#3b82f6">blue</b> is what you played,
					<b style="color:#22c55e">green</b> is the best. Use ◀ ▶ to pause and step.
				</p>
			{:else}
				<button type="button" class="btn btn--primary" onclick={reviewGame}>🔍 Review game</button>
			{/if}
		</div>
	{/if}

	{#if game}
		<div class="board-host">
			<ChessBoard {store} {game} {members} myUid={YOU} {isPremium} {reviewData} solo />
		</div>
	{/if}
</div>

<style>
	.solo {
		/* controls fold into the header menu; the board fills the room */
		--board-cap: min(94vw, calc(100svh - 170px), 860px);
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: center;
		padding-bottom: 24px;
	}
	.solo-head {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		max-width: var(--board-cap, 520px);
	}
	.title {
		margin: 0;
		font-size: 1.25rem;
		flex: 1;
		text-align: center;
	}
	/* difficulty + new game folded into a kebab so the board gets the room */
	.game-menu {
		position: relative;
	}
	.game-menu > summary {
		list-style: none;
		cursor: pointer;
	}
	.game-menu > summary::-webkit-details-marker {
		display: none;
	}
	.menu-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		min-width: 210px;
		box-shadow: var(--shadow-lg);
	}
	.menu-label {
		font-size: 0.8rem;
		color: var(--text-dim);
	}
	.levels {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.review-card {
		padding: 12px 16px;
		text-align: center;
		width: 100%;
		max-width: var(--board-cap, 520px);
	}
	/* give the reused ChessBoard card a definite full width so its board reaches
	   --board-cap and centres, instead of shrinking to content in the centred host */
	.board-host {
		width: 100%;
		max-width: calc(var(--board-cap, 520px) + 40px); /* board + the card's 20px padding each side */
	}
	.board-host :global(.card) {
		width: 100%;
		box-sizing: border-box;
	}
	.board-host :global(.board) {
		margin-inline: auto;
	}
</style>

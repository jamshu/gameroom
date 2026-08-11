import { Chess } from 'chess.js';

/**
 * Stockfish, as a "what should I play here?" service for the chess board.
 *
 * CLIENT ONLY. This must never be imported from src/lib/shared/ — that tree is
 * bundled into the Durable Object by wrangler, `npm run check:noenv` enforces it,
 * and a Web Worker has no meaning there anyway.
 *
 * Mirrors the create* rune-module pattern of createChessClock / createFullscreen:
 * call once during component init, then read `busy` and await `analyse(fen)`.
 *
 * The engine lives in /static/engine (see its README): a single-threaded WASM
 * build that speaks UCI over postMessage.
 */

const ENGINE_URL = '/engine/stockfish.wasm.js';

/**
 * Search depth. 15 is well past the point where a human could tell the difference
 * — Stockfish 10 at depth 15 is already far beyond club strength — and keeps a
 * search on a mid-range phone to roughly a second. Raising it buys nothing a hint
 * user can perceive and costs responsiveness on exactly the devices that need it.
 */
const DEPTH = 15;

/** Give up rather than leave the button spinning if the worker never answers. */
const TIMEOUT_MS = 20000;

/** Does anyone have a move here? False for checkmate and stalemate. */
function hasLegalMove(fen) {
	try {
		return new Chess(fen).moves().length > 0;
	} catch {
		return false; // unparseable position — nothing sensible to suggest
	}
}

export function createChessEngine() {
	let busy = $state(false);

	let worker = null;
	let booting = null; // Promise<Worker> while the handshake is in flight
	/** The one search we're waiting on: { fen, resolve, reject, timer }. */
	let pending = null;

	function handle(text) {
		if (typeof text !== 'string') return;
		if (!pending) return;

		// Info lines stream the running evaluation; keep the latest for the review,
		// which needs the score, not just the move. cp/mate are from the moving
		// side's point of view — exactly what the classifier below expects.
		if (text.startsWith('info')) {
			const s = parseScore(text);
			if (s) pending.score = s;
			return;
		}
		if (!text.startsWith('bestmove')) return;

		const req = pending;
		pending = null;
		clearTimeout(req.timer);
		busy = false;

		// "bestmove e2e4 ponder e7e5", or "bestmove (none)" in a finished position.
		const uci = text.split(/\s+/)[1];
		const move = uci && uci !== '(none)' ? describe(req.fen, uci) : null;
		req.resolve(move ? { ...move, ...(req.score || { cp: null, mate: null }) } : null);
	}

	/** "score cp 34" / "score mate -2" from a UCI info line, or null. */
	function parseScore(text) {
		const m = text.match(/\bscore (cp|mate) (-?\d+)\b/);
		if (!m) return null;
		return m[1] === 'cp' ? { cp: Number(m[2]), mate: null } : { cp: null, mate: Number(m[2]) };
	}

	/**
	 * Turn a UCI move into something the board can render, using the chess.js that
	 * is already in the bundle. Returns null rather than throwing if the engine and
	 * chess.js somehow disagree about legality — a missing hint beats a broken board.
	 */
	function describe(fen, uci) {
		try {
			const mv = new Chess(fen).move({
				from: uci.slice(0, 2),
				to: uci.slice(2, 4),
				promotion: uci[4] || 'q'
			});
			return { fen, from: mv.from, to: mv.to, san: mv.san };
		} catch {
			return null;
		}
	}

	/** Boot the worker and complete the UCI handshake. Cached after the first call. */
	function boot() {
		if (worker) return Promise.resolve(worker);
		if (booting) return booting;

		booting = new Promise((resolve, reject) => {
			let w;
			try {
				w = new Worker(ENGINE_URL);
			} catch (e) {
				booting = null;
				reject(e);
				return;
			}

			const onBootMessage = (e) => {
				const text = typeof e.data === 'string' ? e.data : '';
				if (text !== 'readyok') return;
				w.removeEventListener('message', onBootMessage);
				w.addEventListener('message', (ev) => handle(ev.data));
				worker = w;
				resolve(w);
			};

			w.addEventListener('message', onBootMessage);
			w.addEventListener('error', (e) => {
				// A worker that failed to start must not be cached, or every later
				// click would await a promise that can never settle.
				booting = null;
				worker = null;
				try {
					w.terminate();
				} catch {
					/* already dead */
				}
				reject(e?.message ? new Error(e.message) : new Error('Engine failed to load'));
			});

			w.postMessage('uci');
			w.postMessage('isready'); // Stockfish answers these in order; readyok implies uciok
		});

		return booting;
	}

	/**
	 * Run one search of `fen` at a given strength. Returns `{ from, to, san, cp,
	 * mate, fen }` or null if there's no move (mate/stalemate).
	 *
	 * `skill` is Stockfish's Skill Level (0..20) — set explicitly every search so a
	 * weak opponent move never leaks its setting into a later full-strength review.
	 *
	 * Callers must check the returned `fen` before rendering. The hint button works
	 * on the opponent's turn too, so an incoming move WILL sometimes land mid-search;
	 * the caller compares against the position on screen for the same reason
	 * ChessBoard compares against `optimisticBaseFen`. Drawing a move from a
	 * superseded position would put a highlight on squares where it is illegal.
	 */
	async function search(fen, skill, depth) {
		// Checkmate and stalemate are answered here, not by the engine. Stockfish 10
		// replies to a position with no legal moves with `info depth 0 score cp 0`
		// and then simply says nothing — no `bestmove` line ever arrives — so asking
		// it would hang until TIMEOUT_MS and surface as a spurious error. chess.js is
		// already loaded and answers instantly; this also skips booting the worker.
		if (!hasLegalMove(fen)) return null;

		// One search at a time. A second call supersedes the first rather than
		// queueing: the answer to the older position is no longer wanted, and UCI
		// gives no way to tell two overlapping `bestmove` lines apart.
		if (pending) {
			const stale = pending;
			pending = null;
			clearTimeout(stale.timer);
			stale.resolve(null);
			worker?.postMessage('stop');
		}

		busy = true;
		let w;
		try {
			w = await boot();
		} catch (e) {
			busy = false;
			throw e;
		}

		return new Promise((resolve, reject) => {
			pending = {
				fen,
				resolve,
				reject,
				score: null,
				timer: setTimeout(() => {
					pending = null;
					busy = false;
					w.postMessage('stop');
					reject(new Error('Engine timed out'));
				}, TIMEOUT_MS)
			};
			// ucinewgame clears the hash: successive searches often jump between
			// unrelated positions (live, then a review position ten plies back), and a
			// carried-over hash is worth nothing there.
			w.postMessage('ucinewgame');
			w.postMessage(`setoption name Skill Level value ${skill}`);
			w.postMessage(`position fen ${fen}`);
			w.postMessage(`go depth ${depth}`);
		});
	}

	/** Full-strength best move + evaluation — the hint and the review. */
	const analyse = (fen, depth = DEPTH) => search(fen, 20, depth);

	/**
	 * The AI opponent's move at a chosen strength. Easy is genuinely beatable;
	 * Hard is far past club level. Defaults sit at Medium.
	 */
	const bestMove = (fen, { skill = 8, depth = 10 } = {}) => search(fen, skill, depth);

	/** Tear the worker down. Call from onDestroy — it will not restart on its own. */
	function dispose() {
		if (pending) {
			clearTimeout(pending.timer);
			pending.resolve(null);
			pending = null;
		}
		busy = false;
		try {
			worker?.terminate();
		} catch {
			/* already dead */
		}
		worker = null;
		booting = null;
	}

	return {
		get busy() {
			return busy;
		},
		analyse,
		bestMove,
		dispose
	};
}

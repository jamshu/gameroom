// Authoritative game rules. Runs in /api routes AND inside the room Durable
// Object — the thief-finder `secret` map never leaves this layer unfiltered in
// either. Re-exported from $lib/server/gamelogic.js so ~19 existing importers
// are unaffected by the move.
//
// ISOMORPHIC BY CONTRACT: every import below must be relative and free of
// `$lib`/`$env`. The DO is bundled by wrangler, outside the SvelteKit build,
// where neither of those specifiers resolves. `check:noenv` enforces this.
import { Chess } from 'chess.js';
import { httpError } from './errors.js';
import {
	LUDO_COLORS,
	LUDO_HOME,
	LUDO_SAFE,
	ludoAbsCell,
	ludoBlockedCells,
	ludoLegalMoves
} from '../ludo-rules.js';
import {
	generate as sudokuGenerate, progressOf, isComplete, FREEZE_MS as SUDOKU_FREEZE_MS
} from './sudoku.js';
import {
	ROUND_MS as MATCH3_ROUND_MS, GRACE_MS as MATCH3_GRACE_MS, scoreCeiling
} from './match3.js';
import { initBlackjack, blackjackView, blackjackScores } from './blackjack.js';
import { initHideFire } from './hidefire.js';
import {
	genTubes as birdsortGen, applyMove as birdsortApply, isSolved as birdsortSolved,
	progressOf as birdsortProgress, sortedCount as birdsortSorted, ROUND_MS as BIRDSORT_ROUND_MS
} from './birdsort.js';

export { blackjackScores };

/* --------------------------------- init ---------------------------------- */

export function initGame(gameType, playerUids, room) {
	if (gameType === 'chess') {
		if (playerUids.length !== 2) throw httpError(400, 'Chess needs exactly 2 players');
		return {
			type: 'chess',
			players: { w: playerUids[0], b: playerUids[1] },
			fen: new Chess().fen(),
			moves: [],
			result: null,
			clock: { w: CHESS_START_MS, b: CHESS_START_MS, turnStartedAt: Date.now() }
		};
	}
	if (gameType === 'carroms') {
		if (playerUids.length !== 2 && playerUids.length !== 4) {
			throw httpError(400, 'Carroms needs 2 or 4 players');
		}
		return {
			type: 'carroms',
			players: playerUids, // turn order; teams: even idx = white, odd idx = black
			turnIdx: 0,
			pieces: initialCarromPieces(),
			scores: { w: 0, b: 0 },
			shotSeq: 0, // monotonic; lastEvent.seq is how a client spots a NEW shot
			lastEvent: null, // {kind,...} drives client replay + sound
			result: null
		};
	}
	if (gameType === 'thief_finder') {
		if (playerUids.length < 3) throw httpError(400, 'Thief Finder needs at least 3 players');
		const drawsTotal = room.x_studio_draws_total || 5;
		const totals = {};
		for (const u of playerUids) totals[u] = 0;
		return {
			type: 'thief_finder',
			// Unique per game instance. Pick events carry it so the append-only log
			// stays game-scoped: a rematch resets `draw` to 1, which would otherwise
			// collide with the PREVIOUS game's draw-1 picks (same room, still in the
			// log) and auto-claim cards nobody opened. The epoch is what keeps each
			// game's picks apart. See filterPickRows.
			epoch: crypto.randomUUID(),
			players: playerUids,
			draw: 0,
			drawsTotal,
			phase: 'idle', // idle -> guessing -> reveal -> ... -> finished
			policeUid: null,
			secret: null, // { uid: roleName } — NEVER serialized to clients
			lastResult: null,
			totals
		};
	}
	if (gameType === 'ludo') {
		if (playerUids.length < 2 || playerUids.length > 4) throw httpError(400, 'Ludo needs 2 to 4 players');
		// 2 players sit opposite (red vs yellow); 3-4 fill the ring in board order.
		const seq = playerUids.length === 2 ? ['red', 'yellow'] : LUDO_COLORS.slice(0, playerUids.length);
		const colors = {};
		const tokens = {};
		playerUids.forEach((uid, i) => {
			colors[uid] = seq[i];
			tokens[uid] = [-1, -1, -1, -1]; // all four start in the yard
		});
		return {
			type: 'ludo',
			players: playerUids, // seat/turn order
			colors, // { uid: 'red'|'green'|'yellow'|'blue' }
			turnIdx: 0,
			dice: null, // last roll 1-6, null until the current player rolls
			rolled: false, // rolled and now owes a move
			sixStreak: 0, // consecutive 6s this turn (three forfeits it)
			tokens, // { uid: [pos,pos,pos,pos] } — see ludo section for the pos encoding
			lastEvent: null, // {kind,...} drives client sound/animation, read off game.v
			finished: [], // uids in the order they brought all four home
			result: null // winner uid once the game ends
		};
	}
	if (gameType === 'videocall') {
		// No board, no turns — the room IS the call. State is just the roster of who
		// may be on it; the mesh + presence ride the existing voice roster/signal.
		if (playerUids.length < 2) throw httpError(400, 'Video Call needs at least 2 players');
		return { type: 'videocall', players: playerUids, result: null };
	}
	if (gameType === 'sudoku') {
		if (playerUids.length < 2 || playerUids.length > 6) {
			throw httpError(400, 'Sudoku needs 2 to 6 players');
		}
		/* Fixed for the race. The solo page offers easy/medium/hard because the
		   player is only competing with themselves; a room would need every player
		   to agree, which means a host setting, an Odoo field and a create-room
		   control. Medium is a 5-10 minute race — the right length for a room —
		   so that is a deliberate non-goal rather than an oversight. */
		const difficulty = 'medium';
		// One deal, played by everyone on their own grid. The seed is minted HERE,
		// like thief-finder's epoch, which is what makes /rematch and resetRound
		// hand out a fresh puzzle for free — they re-run initGame. Reusing a room
		// seed would replay the grid the players just solved.
		const seed = crypto.randomUUID();
		const { puzzle, solution } = sudokuGenerate(seed, difficulty);
		return {
			type: 'sudoku',
			players: playerUids,
			seed,
			difficulty,
			puzzle, // public: the dealt grid, identical for everyone
			solution, // SECRET — stripped by gameView, never serialized to a client
			startedAt: Date.now(),
			// per-player sub-state; nobody ever writes anyone else's entry
			boards: Object.fromEntries(
				playerUids.map((u) => [u, { filled: {}, mistakes: 0, frozenUntil: 0, doneAt: null }])
			),
			result: null // winner uid once someone completes their grid
		};
	}
	if (gameType === 'match3') {
		if (playerUids.length < 2 || playerUids.length > 6) {
			throw httpError(400, 'Candy Match needs 2 to 6 players');
		}
		// Only a seed: unlike sudoku there is no finite board to deal, because the
		// refill queue is unbounded. Every client builds the same starting board
		// from this and generates its own tiles from there (see shared/match3.js).
		return {
			type: 'match3',
			players: playerUids,
			seed: crypto.randomUUID(),
			startedAt: Date.now(),
			durationMs: MATCH3_ROUND_MS,
			scores: Object.fromEntries(
				playerUids.map((u) => [u, { score: 0, swaps: 0, finishedAt: null }])
			),
			// Per-player swap logs, kept for replay validation. Stripped by gameView:
			// audit data, not gameplay data.
			logs: Object.fromEntries(playerUids.map((u) => [u, []])),
			result: null
		};
	}
	if (gameType === 'birdsort') {
		if (playerUids.length < 2 || playerUids.length > 6) {
			throw httpError(400, 'Bird Sort needs 2 to 6 players');
		}
		// One deal, played by everyone on their own tubes. Seed minted here like
		// sudoku's, so /rematch and resetRound hand out a fresh puzzle for free by
		// re-running initGame. `start` ships whole (no hidden solution, unlike
		// sudoku) — every player begins from the identical scramble and races.
		const seed = crypto.randomUUID();
		const start = birdsortGen(seed);
		return {
			type: 'birdsort',
			players: playerUids,
			seed,
			start, // public: the dealt tubes, identical for everyone
			startedAt: Date.now(),
			durationMs: BIRDSORT_ROUND_MS,
			// per-player sub-state; nobody ever writes anyone else's tubes
			boards: Object.fromEntries(
				playerUids.map((u) => [u, { tubes: start.map((t) => t.slice()), moves: 0, doneAt: null }])
			),
			result: null // winner uid once someone sorts, or the timeout leader
		};
	}
	// Blackjack mints its own shuffled deck here, so /rematch and resetRound re-deal
	// for free by re-running initGame — the same trick the sudoku seed uses. Rules +
	// the hidden dealer-hole view live in shared/blackjack.js.
	if (gameType === 'blackjack') return initBlackjack(playerUids);
	if (gameType === 'hidefire') {
		if (playerUids.length < 2 || playerUids.length > 8) {
			throw httpError(400, 'Hide & Fire needs 2 to 8 players');
		}
		// Two teams (A/B), last team standing. First round only — subsequent rounds
		// re-arm in place via the hidefire/next action (nextRound), keeping teams and
		// carrying the score, not by re-running initGame.
		return initHideFire(playerUids);
	}
	throw httpError(400, 'Unknown game type');
}

/* ------------------------------ thief-finder ------------------------------ */

const POLICE_POINTS = 800;
// Clients see state through a ~2s poll, so re-dealing instantly would skip the
// reveal entirely for everyone else. The host's client auto-deals once this
// window elapses; the guard below is what actually enforces it. 3s > the 2s
// poll + 300ms jitter, so every visible client lands at least one poll inside
// the reveal window.
export const REVEAL_HOLD_MS = 3000;
// Graded roles beyond Thief/Police, highest first; sliced to player count - 2.
const ROLE_LADDER = [
	['King', 1000], ['Queen', 900], ['Minister', 700], ['Soldier', 600],
	['Sepoy', 500], ['Guard', 400], ['Farmer', 300], ['Trader', 250],
	['Barber', 200], ['Cobbler', 150]
];

export function rolePoints(role) {
	if (role === 'Thief') return 0;
	if (role === 'Police') return POLICE_POINTS;
	return ROLE_LADDER.find(([n]) => n === role)?.[1] ?? 0;
}

function shuffled(arr) {
	const a = [...arr];
	const rand = new Uint32Array(a.length);
	crypto.getRandomValues(rand);
	for (let i = a.length - 1; i > 0; i--) {
		const j = rand[i] % (i + 1);
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/** Host lays the envelopes: roles shuffled onto envelope slots, none claimed yet. */
export function thiefDeal(game) {
	if (game.phase !== 'idle' && game.phase !== 'reveal') throw httpError(409, 'Draw already in progress');
	if (game.draw >= game.drawsTotal) throw httpError(409, 'All draws are done');
	if (game.phase === 'reveal' && Date.now() - (game.revealedAt || 0) < REVEAL_HOLD_MS) {
		throw httpError(409, 'Let everyone see the reveal first');
	}
	const roles = ['Thief', 'Police', ...ROLE_LADDER.slice(0, game.players.length - 2).map(([n]) => n)];
	// index = envelope slot, value = role. SECRET — filtered out of every client view.
	game.envelopes = shuffled(roles);
	game.claims = {}; // envelopeIdx -> uid, filled as players open envelopes
	game.secret = null; // full {uid: role} set only once every envelope is claimed
	game.policeUid = null; // revealed the moment the police envelope is opened
	game.draw += 1;
	game.phase = 'picking';
	game.lastResult = null;
}

/**
 * Rebuild the claim map from the append-only pick log (source of truth). Pure
 * except for mutating `game`. `pickRows` MUST be sorted by Odoo id asc — that
 * order IS the first-come tiebreak. Returns true if anything changed.
 *
 * A pick is honoured only if its envelope is still free AND the picker holds no
 * envelope yet; everything else (a collision loser, a double-pick) is ignored.
 * Rebuilding from the whole log every time makes a lost blob write self-healing.
 */
export function resolveClaims(game, pickRows) {
	const before = JSON.stringify([game.claims, game.policeUid, game.phase]);
	const claims = {};
	const held = new Set();
	for (const row of pickRows) {
		const uid = Number(row.x_studio_sender_uid);
		const k = safePayload(row).envelope;
		if (k == null || claims[k] != null || held.has(uid)) continue;
		if (k < 0 || k >= game.envelopes.length) continue;
		claims[k] = uid;
		held.add(uid);
	}
	game.claims = claims;
	const policeK = game.envelopes.findIndex((r) => r === 'Police');
	game.policeUid = claims[policeK] ?? null;
	if (Object.keys(claims).length === game.players.length) {
		game.secret = {};
		for (const [k, uid] of Object.entries(claims)) game.secret[uid] = game.envelopes[k];
		game.phase = 'guessing';
	}
	return JSON.stringify([game.claims, game.policeUid, game.phase]) !== before;
}

function safePayload(row) {
	try {
		return JSON.parse(row.x_studio_payload || '{}');
	} catch {
		return {};
	}
}

/**
 * Narrow the room's whole pick log to just THIS game's current draw. The log is
 * append-only and never cleared on rematch, so it can hold picks from earlier
 * games in the same room; matching on `epoch` (per game) AND `draw` (per round)
 * is what stops a previous game's picks being replayed into a fresh one.
 * PURE — the Odoo query stays in the routes; this is the shared, testable filter.
 */
export function filterPickRows(rows, game) {
	return rows.filter((r) => {
		const p = safePayload(r);
		return p.epoch === game.epoch && p.draw === game.draw;
	});
}

export function thiefGuess(game, guesserUid, accusedUid) {
	if (game.phase !== 'guessing') throw httpError(409, 'No draw awaiting a guess');
	if (guesserUid !== game.policeUid) throw httpError(403, 'Only the Police can guess');
	if (!game.players.includes(accusedUid)) throw httpError(400, 'Accused is not a player');
	if (accusedUid === guesserUid) throw httpError(400, 'You cannot accuse yourself');

	const thiefUid = Number(Object.keys(game.secret).find((u) => game.secret[u] === 'Thief'));
	const correct = accusedUid === thiefUid;
	const points = {};
	for (const uid of game.players) {
		const role = game.secret[uid];
		if (role === 'Police') points[uid] = correct ? POLICE_POINTS : 0;
		else if (role === 'Thief') points[uid] = correct ? 0 : POLICE_POINTS;
		else points[uid] = rolePoints(role);
		game.totals[uid] = (game.totals[uid] || 0) + points[uid];
	}
	game.lastResult = { draw: game.draw, roles: { ...game.secret }, accusedUid, thiefUid, correct, points };
	game.revealedAt = Date.now();
	game.secret = null;
	game.policeUid = null;
	game.phase = game.draw >= game.drawsTotal ? 'finished' : 'reveal';
	return game.lastResult;
}

/** Per-session view — the only thief-finder shape clients ever receive. */
export function thiefView(game, uid) {
	// picking: expose the public claim map + the caller's OWN card only. The
	// `envelopes` role array and the full `secret` map never leave the server.
	const picking = game.phase === 'picking';
	const myKey = picking ? Object.keys(game.claims || {}).find((k) => game.claims[k] === uid) : null;
	const myEnvIdx = myKey != null ? Number(myKey) : null;
	return {
		type: game.type,
		players: game.players,
		draw: game.draw,
		drawsTotal: game.drawsTotal,
		phase: game.phase,
		policeUid: game.policeUid,
		envelopeCount: picking ? game.envelopes.length : 0,
		claims: picking ? game.claims : null,
		myEnvelope: myEnvIdx,
		myRole:
			picking && myEnvIdx != null
				? game.envelopes[myEnvIdx]
				: game.phase === 'guessing' && game.secret
					? game.secret[uid] || null
					: null,
		lastResult: game.phase === 'reveal' || game.phase === 'finished' ? game.lastResult : null,
		// remaining ms, not an absolute timestamp — the client anchors it on
		// receipt, so a skewed client clock can't break the countdown. Also set
		// while `finished`: the deciding guess flips the room to finished at
		// once, and the room page uses this to hold the final reveal on screen
		// before swapping in the leaderboard.
		revealHoldMs:
			game.phase === 'reveal' || game.phase === 'finished'
				? Math.max(0, (game.revealedAt || 0) + REVEAL_HOLD_MS - Date.now())
				: 0,
		totals: game.totals
	};
}

/* ---------------------------------- ludo ---------------------------------- */

/* The position encoding, the ring constants and the legality rule all live in
   ../ludo-rules.js — the board component imports the same ones, so the highlight
   it draws and the move this file accepts can never disagree. Only the parts
   that THROW stay here. Re-exported so existing importers (routes, ludo-check)
   are unaffected. */
export { ludoLegalMoves, ludoBlockedCells };

/** Advance to the next player and clear the per-turn roll state. */
function advanceLudoTurn(game) {
	game.turnIdx = (game.turnIdx + 1) % game.players.length;
	game.sixStreak = 0;
	game.dice = null;
	game.rolled = false;
}

/**
 * Record a die roll for the current player. `die` (1-6) is generated in the
 * route so this stays pure/testable. Three 6s in a row, or a roll with no legal
 * move, forfeits the turn. Otherwise the player now owes a move (`rolled`).
 */
export function ludoRoll(game, uid, die) {
	if (game.result) throw httpError(409, 'Game is finished');
	if (uid !== game.players[game.turnIdx]) throw httpError(403, 'Not your turn');
	if (game.rolled) throw httpError(409, 'Move your token before rolling again');

	game.dice = die;
	game.sixStreak = die === 6 ? (game.sixStreak || 0) + 1 : 0;

	if (game.sixStreak >= 3) {
		// `die` is carried here too (it's always 6) so the client can land its dice
		// animation on it — advanceLudoTurn is about to clear game.dice.
		game.lastEvent = { kind: 'pass', uid, die, reason: 'three-sixes' };
		advanceLudoTurn(game);
		return;
	}
	if (ludoLegalMoves(game, uid, die).length === 0) {
		game.lastEvent = { kind: 'pass', uid, die };
		advanceLudoTurn(game);
		return;
	}
	game.rolled = true;
	game.lastEvent = { kind: 'roll', uid, die };
}

/**
 * Move token `tokenIdx` by the pending dice. Resolves capture (a lone opponent
 * token on a non-safe cell goes back to the yard) and home. Rolling a 6,
 * capturing, or bringing a token home grants another roll; otherwise the turn
 * passes. Sets `result` when the mover brings all four home. PURE (no I/O).
 */
export function ludoMove(game, uid, tokenIdx) {
	if (game.result) throw httpError(409, 'Game is finished');
	if (uid !== game.players[game.turnIdx]) throw httpError(403, 'Not your turn');
	if (!game.rolled || game.dice == null) throw httpError(409, 'Roll the dice first');

	const t = Number(tokenIdx);
	const dice = game.dice;
	const mv = ludoLegalMoves(game, uid, dice).find((m) => m.token === t);
	if (!mv) throw httpError(400, 'That token cannot move');

	const color = game.colors[uid];
	game.tokens[uid][t] = mv.target;

	// capture: only on the shared ring, only off a safe cell, only a lone token
	let captured = false;
	const absT = ludoAbsCell(color, mv.target);
	if (absT != null && !LUDO_SAFE.has(absT)) {
		for (const other of game.players) {
			if (other === uid) continue;
			const oColor = game.colors[other];
			const otoks = game.tokens[other];
			const onCell = [];
			for (let j = 0; j < otoks.length; j++) {
				if (ludoAbsCell(oColor, otoks[j]) === absT) onCell.push(j);
			}
			if (onCell.length === 1) {
				otoks[onCell[0]] = -1; // sent home; a 2+ stack is a blockade and is immune
				captured = true;
			}
		}
	}

	const reachedHome = mv.target === LUDO_HOME;
	game.lastEvent = { kind: captured ? 'capture' : reachedHome ? 'home' : 'move', uid, token: t, die: dice };

	if (game.tokens[uid].every((p) => p === LUDO_HOME)) {
		game.finished.push(uid);
		game.result = uid;
		game.rolled = false;
		game.dice = null;
		return;
	}

	if (dice === 6 || captured || reachedHome) {
		// extra roll — same player, keep sixStreak for the three-6s rule
		game.rolled = false;
		game.dice = null;
	} else {
		advanceLudoTurn(game);
	}
}

/** Per-uid score for finishRoom: total token progress (yard 0 … home 57). */
export function ludoScores(game) {
	const scores = {};
	for (const uid of game.players) {
		scores[uid] = (game.tokens[uid] || []).reduce((sum, p) => sum + (p < 0 ? 0 : p + 1), 0);
	}
	return scores;
}

/* --------------------------------- chess ---------------------------------- */

export const CHESS_START_MS = 600000; // 10 minutes each

/**
 * THE CLOCK INVARIANT — stated once, because two code paths depend on it:
 *
 *   stored `clock[c]` is the remaining ms for colour `c` AS OF `turnStartedAt`.
 *   Only the side to move differs from stored, by `now - turnStartedAt`.
 *
 * `chessClockNow` reports; `chessClockCommit` folds elapsed time into the mover.
 * If these ever compute differently, time gets double-deducted.
 */

/** Side to move, straight from the FEN (field 1) — cheaper than parsing the board. */
function fenTurn(fen) {
	return fen?.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** Live remaining ms for both sides. PURE — never mutates `game`. */
export function chessClockNow(game, now = Date.now()) {
	const c = game?.clock;
	if (!c) return null; // game started before clocks shipped
	if (game.result) return { w: c.w, b: c.b, ticking: null }; // finished: frozen
	const ticking = fenTurn(game.fen);
	const elapsed = Math.max(0, now - (c.turnStartedAt ?? now));
	return { w: c.w, b: c.b, ticking, [ticking]: Math.max(0, c[ticking] - elapsed) };
}

/** Fold elapsed time into the mover's budget. Returns true if they ran out. */
export function chessClockCommit(game, now = Date.now()) {
	const live = chessClockNow(game, now);
	if (!live?.ticking) return false;
	game.clock[live.ticking] = live[live.ticking];
	game.clock.turnStartedAt = now;
	return live[live.ticking] <= 0;
}

/**
 * How a chess game ended, in words.
 *
 * Lives here, next to winnerUids, because TWO places render it — the room's
 * announcement banner and the board's own status chip — and they were already
 * describing the same game differently: the board said "wins by resignation"
 * while the banner said nothing at all. One map, one wording.
 *
 * `reason` is game.endReason. An unknown or missing reason is not an error: it
 * is every non-chess game (ludo, carroms and thief all publish game-over with no
 * endReason) and any chess game finished before this field existed. Those fall
 * back to the plain result, which is still true, just less specific.
 */
const CHESS_WIN_REASON = {
	checkmate: 'by checkmate',
	timeout: 'on time',
	resign: 'by resignation'
};
const CHESS_DRAW_REASON = {
	stalemate: 'stalemate',
	repetition: 'threefold repetition',
	insufficient: 'insufficient material',
	'fifty-move': 'the fifty-move rule',
	'draw-agreed': 'agreement'
};

/**
 * "Ayesha wins by checkmate" / "You win on time" / "Draw by stalemate".
 *
 * `name` is already resolved to a display name by the caller — this module is
 * shared with the DO and has no roster to look one up in. `isYou` only picks the
 * verb; the banner addresses the reader in second person ("You win"), and
 * "You wins" is the tell that a template forgot who it was talking to.
 */
export function chessOutcomeText(result, reason, name, isYou = false) {
	if (result === 'draw') {
		const how = CHESS_DRAW_REASON[reason];
		return how ? `Draw by ${how}` : 'Draw';
	}
	if (!result) return '';
	const verb = isYou ? 'win' : 'wins';
	const how = CHESS_WIN_REASON[reason];
	return how ? `${name} ${verb} ${how}` : `${name} ${verb}`;
}

/** Win 1, draw 1 each. Shared by the move and flag routes so they can't drift. */
export function chessScores(game) {
	return {
		[game.players.w]: game.result === 'w' ? 1 : game.result === 'draw' ? 1 : 0,
		[game.players.b]: game.result === 'b' ? 1 : game.result === 'draw' ? 1 : 0
	};
}

/**
 * Who WON — the uids that earn a point on the room scoreboard. Pure.
 *
 * Each game stores its outcome differently (chess a colour, ludo a uid, carroms
 * a team, thief a totals map), so this is the one place that knows how to read
 * all four. Returns [] for a draw, an unfinished game, or a type that never ends.
 *
 * NOT derived by taking the top of `scoresByUid`, which is the obvious shortcut
 * and is wrong twice over: chess scores a draw 1-1, and both carrom teammates
 * carry their team's pocketed count, so an "outright top scorer" rule would
 * silently award nobody for a doubles win. Read the result field instead.
 */
export function winnerUids(game) {
	if (!game) return [];
	if (game.type === 'chess') {
		if (!game.result || game.result === 'draw') return [];
		return [game.players[game.result]].filter((u) => u != null);
	}
	if (game.type === 'ludo') return game.result ? [game.result] : [];
	if (game.type === 'carroms') {
		// result is a TEAM — everyone on it scores, so 2v2 pays both partners
		if (!game.result) return [];
		return game.players.filter((u) => carromTeamOf(game, u) === game.result);
	}
	if (game.type === 'thief_finder') {
		if (game.phase !== 'finished') return [];
		const totals = game.totals || {};
		const top = Math.max(0, ...Object.values(totals));
		if (top <= 0) return [];
		// ties all score: the round genuinely had joint winners
		return Object.keys(totals)
			.filter((u) => totals[u] === top)
			.map(Number);
	}
	if (game.type === 'sudoku') {
		// The race ends the moment someone completes their grid, so there is
		// exactly one winner and it is recorded in `result`.
		return game.result ? [game.result] : [];
	}
	if (game.type === 'birdsort') {
		// Like sudoku: first to sort (or the timeout leader) is recorded in `result`.
		return game.result ? [game.result] : [];
	}
	if (game.type === 'match3') {
		if (!game.result) return [];
		// Ties all score — two players genuinely reaching the same score in 90
		// seconds is a joint win, the same way thief-finder treats a tied total.
		const top = Math.max(0, ...Object.values(game.scores || {}).map((s) => s?.score || 0));
		if (top <= 0) return []; // nobody scored: no winner rather than everyone
		return Object.keys(game.scores || {})
			.filter((u) => (game.scores[u]?.score || 0) === top)
			.map(Number);
	}
	if (game.type === 'blackjack') {
		if (game.result !== 'done') return [];
		// Everyone who beat the dealer scores — a table can have several winners.
		return game.players.filter((u) => game.outcomes?.[u] === 'win').map(Number);
	}
	return []; // videocall and anything new that never finishes
}

/* ------------------------- race arbiters (shared) -------------------------
   The rules for the two race games, written ONCE and called from both the /api
   route and the Durable Object — the same "one arbiter, two stores" shape
   resolveClaims already uses for thief-finder picks. Each mutates `game` in
   place and reports what happened; neither reads a clock it wasn't given, so
   the caller decides what "now" means and the check script can pin the edges. */

/**
 * Apply one sudoku entry for `uid`.
 *
 * A wrong digit is REJECTED, not placed: the grid therefore only ever holds
 * correct digits, which is what lets the finish test be "every editable cell is
 * filled" without re-deriving the solution client-side. The cost is a freeze,
 * enforced here rather than in the UI — a client that ignores its own countdown
 * still gets refused.
 */
export function applySudokuFill(game, uid, cell, digit, now = Date.now()) {
	const board = game?.boards?.[uid];
	if (!board) return { ok: false, status: 403, error: 'Not a player in this game' };
	if (game.result) return { ok: false, status: 409, error: 'The race is over' };
	if (board.doneAt) return { ok: false, status: 409, error: 'You have already finished' };

	/* parseInt for the non-number cases, NOT Number(): `Number(null)` and
	   `Number('')` are both 0, which is a valid cell index — so a request with a
	   missing or empty `cell` would silently be applied to the top-left square
	   instead of being refused. parseInt yields NaN for all of those. A float is
	   kept as-is so `Number.isInteger` can still reject it. */
	const i = typeof cell === 'number' ? cell : Number.parseInt(cell, 10);
	const d = typeof digit === 'number' ? digit : Number.parseInt(digit, 10);
	if (!Number.isInteger(i) || i < 0 || i > 80) return { ok: false, status: 400, error: 'No such cell' };
	if (!Number.isInteger(d) || d < 1 || d > 9) return { ok: false, status: 400, error: 'Not a digit' };
	if (game.puzzle[i] !== 0) return { ok: false, status: 400, error: 'That cell is a given' };
	if (board.filled?.[i]) return { ok: false, status: 409, error: 'That cell is already filled' };
	if ((board.frozenUntil || 0) > now) {
		return { ok: false, status: 429, code: 'frozen', error: 'Still frozen', frozenUntil: board.frozenUntil };
	}

	if (game.solution[i] !== d) {
		board.mistakes = (board.mistakes || 0) + 1;
		board.frozenUntil = now + SUDOKU_FREEZE_MS;
		return { ok: true, correct: false, frozenUntil: board.frozenUntil, mistakes: board.mistakes };
	}

	board.filled = { ...(board.filled || {}), [i]: d };
	if (isComplete(game.puzzle, board.filled)) {
		board.doneAt = now;
		// First to complete wins outright; a later finisher cannot displace them.
		if (!game.result) game.result = Number(uid);
	}
	return { ok: true, correct: true, finished: !!board.doneAt, won: game.result === Number(uid) };
}

/**
 * Apply one bird-sort pour for `uid` to their own tubes.
 *
 * Validated server-side (unlike match-3, whose board is client-generated): the
 * move is legal or it is refused, and the tubes the server holds are the truth,
 * so "first to sort" cannot be faked. First to fully sort wins outright; a later
 * finisher cannot displace them.
 */
export function applyBirdsortMove(game, uid, from, to, now = Date.now()) {
	const board = game?.boards?.[uid];
	if (!board) return { ok: false, status: 403, error: 'Not a player in this game' };
	if (game.result) return { ok: false, status: 409, error: 'The race is over' };
	if (board.doneAt) return { ok: false, status: 409, error: 'You have already finished' };

	const f = typeof from === 'number' ? from : Number.parseInt(from, 10);
	const t = typeof to === 'number' ? to : Number.parseInt(to, 10);
	if (!Number.isInteger(f) || !Number.isInteger(t)) {
		return { ok: false, status: 400, error: 'No such tube' };
	}

	const next = birdsortApply(board.tubes, f, t);
	if (!next) return { ok: false, status: 400, error: 'Illegal pour' };

	board.tubes = next;
	board.moves = (board.moves || 0) + 1;
	if (birdsortSolved(next)) {
		board.doneAt = now;
		if (!game.result) game.result = Number(uid);
	}
	return { ok: true, moves: board.moves, finished: !!board.doneAt, won: game.result === Number(uid) };
}

/** Has the bird-sort round's safety clock run out? */
export function birdsortExpired(game, now = Date.now()) {
	if (!game?.startedAt) return false;
	return now >= game.startedAt + (game.durationMs || BIRDSORT_ROUND_MS);
}

/**
 * Close a bird-sort round whose clock expired with nobody finished: the leader by
 * completed tubes (ties broken by join order) is declared the winner, so the room
 * cannot hang if the puzzle proves too hard in the time. No-op once someone won.
 */
export function closeBirdsort(game, now = Date.now()) {
	if (game?.result) return false;
	if (!birdsortExpired(game, now)) return false;
	let best = null;
	let bestSorted = -1;
	for (const u of game.players) {
		const s = birdsortSorted(game.boards?.[u]?.tubes || []);
		if (s > bestSorted) {
			bestSorted = s;
			best = u;
		}
	}
	game.result = best != null ? Number(best) : null;
	return true;
}

/** One point to whoever sorted first (or led at the timeout). */
export function birdsortScores(game) {
	return Object.fromEntries(
		gameSeatUids(game).map((u) => [u, Number(u) === Number(game.result) ? 1 : 0])
	);
}

/** Has the match-3 round's clock run out, by the server's own stamps? */
export function match3Expired(game, now = Date.now()) {
	if (!game?.startedAt) return false;
	return now >= game.startedAt + (game.durationMs || MATCH3_ROUND_MS);
}

/**
 * Record a player's final match-3 score.
 *
 * The score is computed by the client — it has to be, because the refill queue
 * is generated client-side from the shared seed (see shared/match3.js). So it is
 * CLAMPED here rather than trusted outright: `scoreCeiling` is an order of
 * magnitude above good play, so it never touches an honest round but refuses a
 * fabricated one. The swap log is kept so `replay()` can turn this into real
 * validation later without a data migration.
 *
 * The round closes when every player has reported, or whenever the clock has
 * run out — whichever comes first, so one player leaving their tab open cannot
 * hold the room hostage.
 */
export function applyMatch3Finish(game, uid, { score, swaps, log } = {}, now = Date.now()) {
	const entry = game?.scores?.[uid];
	if (!entry) return { ok: false, status: 403, error: 'Not a player in this game' };
	if (entry.finishedAt) return { ok: false, status: 409, error: 'Already reported' };
	if (!match3Expired(game, now)) return { ok: false, status: 409, error: 'The round is still running' };

	const elapsed = Math.max(0, now - game.startedAt);
	const claimed = Math.max(0, Math.floor(Number(score) || 0));
	entry.score = Math.min(claimed, scoreCeiling(elapsed));
	entry.swaps = Math.max(0, Math.floor(Number(swaps) || 0));
	entry.finishedAt = now;
	if (Array.isArray(log)) game.logs[uid] = log;

	const everyoneIn = Object.values(game.scores).every((s) => s.finishedAt);
	if (everyoneIn && !game.result) game.result = 'done';
	return { ok: true, score: entry.score, clamped: entry.score < claimed, finished: everyoneIn };
}

/**
 * Close a match-3 round whose clock has expired, scoring everyone who never
 * reported as they stand. Called by the finish endpoint so one straggler — a
 * closed tab, a dead connection — cannot leave the room stuck mid-game.
 */
export function closeMatch3(game, now = Date.now()) {
	if (game?.result) return false;
	// Grace, not merely expiry: every player reports independently, so closing on
	// the first report to arrive would write off everyone still mid-request — a
	// race won by whoever has the fastest connection rather than the best round.
	if (!match3Expired(game, now - MATCH3_GRACE_MS)) return false;
	for (const s of Object.values(game.scores || {})) if (!s.finishedAt) s.finishedAt = now;
	game.result = 'done';
	return true;
}

/** One point to whoever completed the grid first. */
export function sudokuScores(game) {
	return Object.fromEntries(
		gameSeatUids(game).map((u) => [u, Number(u) === Number(game.result) ? 1 : 0])
	);
}

/** One point to the top scorer(s); a tie pays everyone who tied. */
export function match3Scores(game) {
	const winners = new Set(winnerUids(game).map(Number));
	return Object.fromEntries(gameSeatUids(game).map((u) => [u, winners.has(Number(u)) ? 1 : 0]));
}

/**
 * The uids holding a seat in `game`. Chess keys its two seats by colour, the
 * other games use a turn-order array — callers that only ask "is this player in
 * the game?" shouldn't have to know which. Pure.
 */
export function gameSeatUids(game) {
	const p = game?.players;
	if (!p) return [];
	return Array.isArray(p) ? [...p] : Object.values(p);
}

/* ------------------------------ client views ------------------------------ */

/**
 * The ONLY shape a game may take when it leaves the server. Thief-finder is
 * filtered per-uid (its `secret` map must never be serialized); chess and
 * carroms hold no secrets.
 *
 * Every caller — the poll and every write endpoint that echoes state back —
 * must go through here. Returning `state.game` raw leaks the thief's identity
 * to the whole room.
 */
export function gameView(game, uid) {
	if (!game) return null;
	if (game.type === 'thief_finder') return thiefView(game, uid);
	if (game.type === 'chess') {
		const live = chessClockNow(game);
		if (!live) return game; // pre-clock game, nothing to project
		// MUST copy: returning `game` by reference and writing a computed clock
		// into it would corrupt the object writeState is about to serialize.
		// `turnStartedAt` is deliberately dropped — shipping an absolute server
		// timestamp would reintroduce exactly the clock skew that sending
		// remaining-ms exists to avoid.
		return { ...game, clock: { w: live.w, b: live.b, ticking: live.ticking } };
	}
	if (game.type === 'sudoku') return sudokuView(game, uid);
	if (game.type === 'birdsort') return birdsortView(game, uid);
	if (game.type === 'match3') return match3View(game);
	// Blackjack hides the dealer's hole card until the round is done.
	if (game.type === 'blackjack') return blackjackView(game, uid);
	return game;
}

/**
 * Sudoku as one player may see it. Two things are withheld, for two reasons:
 *
 *   `solution` — the answer key. Shipping it would end the game.
 *   every OTHER player's `filled` map — their answers are the answer key. A
 *   rival's grid is a live, growing copy of the solution, so leaking it is the
 *   same leak by a slower route. This is the one people forget.
 *
 * Rivals are projected down to what the ticker actually renders: how far along
 * they are, how many mistakes they've made, and whether they've finished.
 *
 * `uid` may hold no seat at all — spectators exist above playerCapacity, and
 * they simply get every player projected. No branch here may assume the viewer
 * is a player.
 */
function sudokuView(game, uid) {
	const me = String(uid);
	const boards = {};
	for (const [id, b] of Object.entries(game.boards || {})) {
		const progress = progressOf(game.puzzle, b?.filled);
		const shared = {
			progress: progress.done,
			total: progress.total,
			pct: progress.pct,
			mistakes: b?.mistakes || 0,
			doneAt: b?.doneAt ?? null
		};
		// own board carries the actual digits and the freeze the UI must honour
		boards[id] = id === me ? { ...shared, filled: b?.filled || {}, frozenUntil: b?.frozenUntil || 0 } : shared;
	}
	const { solution, ...rest } = game;
	return { ...rest, boards };
}

/**
 * Bird Sort as one player may see it. Rivals are projected down to the ticker's
 * metrics — how far along, how many moves, whether finished — rather than their
 * full tube arrangement, which is a live worked example a rival could copy. The
 * viewer's own board carries the actual tubes. `uid` may be a spectator with no
 * seat, so no branch may assume the viewer is a player.
 */
function birdsortView(game, uid) {
	const me = String(uid);
	const boards = {};
	for (const [id, b] of Object.entries(game.boards || {})) {
		const progress = birdsortProgress(b?.tubes);
		const shared = {
			progress: progress.done,
			total: progress.total,
			pct: progress.pct,
			moves: b?.moves || 0,
			doneAt: b?.doneAt ?? null
		};
		boards[id] = id === me ? { ...shared, tubes: b?.tubes || [] } : shared;
	}
	return { ...game, boards };
}

/**
 * Match-3 as one player may see it. The seed is deliberately public — both
 * players building the same board from it IS the game — so the only thing
 * stripped is the per-player swap logs, which are audit data for replay
 * validation and would otherwise let a client watch a rival's moves live.
 */
function match3View(game) {
	const { logs, ...rest } = game;
	return rest;
}

/** The per-session `state` envelope shared by the poll and POST responses. */
export function stateView(state, uid) {
	if (!state) return null;
	return {
		v: state.v,
		voice: state.voice || [],
		// elapsed-at-serialize, NOT the raw stamp — same reasoning as the chess
		// clock above: an absolute server timestamp differenced against the
		// client's Date.now() would show the viewer's clock skew as call duration.
		voiceMs: state.voiceSince ? Math.max(0, Date.now() - state.voiceSince) : null,
		// Cumulative room scoreboard, { uid: wins }. This list is an ALLOWLIST —
		// anything not named here never reaches a client, however faithfully it is
		// persisted, because the socket push, the poll envelope and the DO's welcome
		// frame all serialize through this one function.
		wins: state.wins || {},
		game: gameView(state.game, uid)
	};
}

/* -------------------------------- carroms --------------------------------- */

// Board is normalized 0..1000, center (500,500). Piece radius 26, striker 30.
// ponytail: mirror of BOARD in src/lib/games/carroms-sim.js — keep R/STRIKER_R/
// POCKET_R equal to it, or the opening layout and the rendered coin size disagree.
export const CARROM = { SIZE: 1000, R: 26, STRIKER_R: 30, POCKET_R: 42, CENTER: 500 };

export function initialCarromPieces() {
	const c = CARROM.CENTER;
	// Two alternating rings, 9 white + 9 black, centre spot left empty — there is
	// no queen in this variant, so nothing sits on it.
	const pieces = [];
	const ring1 = 2 * CARROM.R + 2; // touching ring
	const ring2 = 2 * ring1;
	let n = 0;
	for (let i = 0; i < 6; i++) {
		const a = (Math.PI / 3) * i;
		pieces.push({ id: `p${n}`, color: i % 2 ? 'b' : 'w', x: c + ring1 * Math.cos(a), y: c + ring1 * Math.sin(a), pocketed: false });
		n++;
	}
	for (let i = 0; i < 12; i++) {
		const a = (Math.PI / 6) * i + Math.PI / 12;
		pieces.push({ id: `p${n}`, color: i % 2 ? 'w' : 'b', x: c + ring2 * Math.cos(a), y: c + ring2 * Math.sin(a), pocketed: false });
		n++;
	}
	return pieces.map((p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) }));
}

export function carromTeamOf(game, uid) {
	const idx = game.players.indexOf(uid);
	return idx < 0 ? null : idx % 2 === 0 ? 'w' : 'b';
}

/**
 * Trusted-client physics: the current player posts settled positions + pocketed
 * ids. Server verifies the piece set is conserved, then applies scoring/turn
 * rules. // ponytail: no shot replay verification — casual game, shooter trusted.
 */
export function carromsApplyShot(game, uid, { positions = [], pocketed = [], strikerPocketed = false, shot = null }) {
	if (game.result) throw httpError(409, 'Game is finished');
	const team = carromTeamOf(game, uid);

	// The queen was removed from the game; a room that was already mid-match when
	// that shipped still has her in its persisted pieces. Drop her here rather
	// than at read time so one shot migrates the board for good — and so the win
	// check below never has to ask about a piece that no longer exists.
	game.pieces = game.pieces.filter((p) => p.color !== 'q');
	delete game.queenPocketedBy;
	delete game.coverPending;

	const live = game.pieces.filter((p) => !p.pocketed);
	const liveIds = new Set(live.map((p) => p.id));
	// `q` is filtered above, so a client still running the pre-removal build could
	// report pocketing a piece the server no longer knows — ignore it instead of
	// rejecting an otherwise legal shot.
	const pocketedSet = new Set(pocketed.filter((id) => id !== 'q'));
	const posMap = new Map(positions.map((p) => [p.id, p]));
	// conservation: every previously-live piece is either newly pocketed or has a position
	for (const p of live) {
		if (!pocketedSet.has(p.id) && !posMap.has(p.id)) throw httpError(400, `Piece ${p.id} missing from shot result`);
	}
	for (const id of pocketedSet) if (!liveIds.has(id)) throw httpError(400, `Piece ${id} is not on the board`);

	// apply positions (clamped to board) and pockets
	for (const p of game.pieces) {
		if (p.pocketed) continue;
		if (pocketedSet.has(p.id)) {
			p.pocketed = true;
		} else {
			const np = posMap.get(p.id);
			p.x = Math.max(CARROM.R, Math.min(CARROM.SIZE - CARROM.R, Math.round(np.x)));
			p.y = Math.max(CARROM.R, Math.min(CARROM.SIZE - CARROM.R, Math.round(np.y)));
		}
	}

	let ownPocketed = 0;
	for (const id of pocketedSet) {
		const piece = game.pieces.find((p) => p.id === id);
		game.scores[piece.color] += 1;
		if (piece.color === team) ownPocketed++;
	}

	let foul = false;
	if (strikerPocketed) {
		foul = true;
		// return one of the shooter's pocketed pieces to center
		const back = game.pieces.find((p) => p.pocketed && p.color === team);
		if (back) {
			back.pocketed = false;
			back.x = CARROM.CENTER;
			back.y = CARROM.CENTER;
			game.scores[team] = Math.max(0, game.scores[team] - 1);
		}
	}

	const continueTurn = ownPocketed > 0 && !foul;
	if (!continueTurn) game.turnIdx = (game.turnIdx + 1) % game.players.length;

	// How the shot was taken, for everyone who didn't take it. The shooter runs
	// the sim locally and watches/hears each impact against their own animation;
	// opponents and spectators receive only this. `shot` carries the four sim
	// INPUTS — striker start and flick velocity — so every other client can
	// re-run the same deterministic simulation against the positions it already
	// holds and replay the real shot, instead of sliding the coins along fake
	// straight lines to the settled result.
	game.lastEvent = {
		kind: 'shot',
		// Monotonic per game. The client can't use the state version to spot a new
		// shot: `v` belongs to the whole room envelope and a voice join or a member
		// change bumps it too, which would replay this shot a second time off an
		// already-settled board. A seq it hasn't seen is the only honest signal.
		seq: (game.shotSeq = (game.shotSeq || 0) + 1),
		uid,
		pocketed: pocketedSet.size,
		foul,
		shot: shot
			? {
					sx: Math.round(shot.sx),
					sy: Math.round(shot.sy),
					// velocities are small and fractional — rounding them to integers
					// would visibly bend the replayed path away from the shooter's
					vx: Math.round(shot.vx * 1000) / 1000,
					vy: Math.round(shot.vy * 1000) / 1000
				}
			: null
	};

	// end: a color fully pocketed
	for (const color of ['w', 'b']) {
		const remaining = game.pieces.filter((p) => p.color === color && !p.pocketed).length;
		if (remaining === 0) game.result = color;
	}
	return { foul, continueTurn };
}

/**
 * How many people one room's WebRTC mesh carries before it degrades.
 *
 * Lives here rather than in the voice route because the CAP IS ENFORCED IN THE
 * OBJECT now. The route used to check it against a blob it had already read and
 * then write back — two joins arriving together both passed. Inside the object
 * the read and the write are one step, so there is no window; the route still
 * imports this only to keep one number in one place.
 */
export const VOICE_CAP = 8;

/**
 * Keep the call-start stamp in step with the voice roster.
 *
 * A call only exists once there are two people in it, so the clock starts on the
 * SECOND join and clears when the roster drops back under two — one person sitting
 * in voice is waiting, not talking. Only writes the stamp when it is absent, so a
 * third person joining does not restart a call already in progress.
 *
 * Lives here, beside stateView, because the room Durable Object ends calls too:
 * a socket closing is the most reliable "they left" signal there is, and the
 * object is $env-free so it cannot reach server/room.js. server/room.js
 * re-exports it, so every existing caller is untouched.
 *
 * Call from EVERY site that touches state.voice — voice join/leave, leaving the
 * room, and being removed by the host. One helper is what stops those drifting.
 */
export function syncVoiceSince(state) {
	if (!state) return state;
	const live = (state.voice || []).length >= 2;
	if (live) state.voiceSince = state.voiceSince || Date.now();
	else state.voiceSince = null;
	return state;
}

/** `roomId` is optional only so the two existing callers could adopt it one at a
 *  time; without it the removed player keeps a live socket. Always pass it. */

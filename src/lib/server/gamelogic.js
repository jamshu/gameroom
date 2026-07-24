// Server-side game rules. Everything here runs only in /api routes — the
// thief-finder `secret` map never leaves this layer unfiltered.
import { Chess } from 'chess.js';
import { httpError } from './room.js';

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
			queenPocketedBy: null, // team ('w'|'b') that pocketed the queen
			coverPending: false,
			scores: { w: 0, b: 0 },
			lastEvent: null, // {kind,...} drives client sound, read off game.v
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

/**
 * Token position encoding (per token, per player):
 *   -1        in the yard (not yet entered)
 *   0..50     on the shared main track, RELATIVE to the player's own start cell
 *             (0 = start). Absolute board cell = (LUDO_START_OFFSET[color] + pos) % 52.
 *   51..56    the player's private 6-cell home column; 56 is the final home (exact).
 * A token needs a 6 to leave the yard, and an exact roll to land on 56.
 */
const LUDO_COLORS = ['red', 'green', 'yellow', 'blue'];
const LUDO_START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
const LUDO_TRACK = 52; // shared ring length
const LUDO_HOME = 56; // final (exact) position
// The 8 star safe cells (absolute): the four coloured start cells + four mid-arm
// stars. A token sitting on one of these can't be captured.
const LUDO_SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** Absolute ring cell for a main-track token, or null if it's in yard/home column. */
function ludoAbsCell(color, pos) {
	if (pos < 0 || pos > 50) return null;
	return (LUDO_START_OFFSET[color] + pos) % LUDO_TRACK;
}

/** Advance to the next player and clear the per-turn roll state. */
function advanceLudoTurn(game) {
	game.turnIdx = (game.turnIdx + 1) % game.players.length;
	game.sixStreak = 0;
	game.dice = null;
	game.rolled = false;
}

/**
 * Legal moves for `uid` given `dice`, as [{ token, target }]. PURE. Yard tokens
 * move only on a 6; a board token moves only if it lands exactly on or before
 * home (pos+dice <= 56 — overshoots are illegal). Own-stacking is allowed.
 */
export function ludoLegalMoves(game, uid, dice) {
	const toks = game.tokens[uid] || [];
	const moves = [];
	for (let i = 0; i < toks.length; i++) {
		const pos = toks[i];
		if (pos === LUDO_HOME) continue; // already finished
		if (pos === -1) {
			if (dice === 6) moves.push({ token: i, target: 0 });
			continue;
		}
		const target = pos + dice;
		if (target <= LUDO_HOME) moves.push({ token: i, target });
	}
	return moves;
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
		game.lastEvent = { kind: 'pass', uid, reason: 'three-sixes' };
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

/** Win 1, draw 1 each. Shared by the move and flag routes so they can't drift. */
export function chessScores(game) {
	return {
		[game.players.w]: game.result === 'w' ? 1 : game.result === 'draw' ? 1 : 0,
		[game.players.b]: game.result === 'b' ? 1 : game.result === 'draw' ? 1 : 0
	};
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
	return game;
}

/** The per-session `state` envelope shared by the poll and POST responses. */
export function stateView(state, uid) {
	if (!state) return null;
	return { v: state.v, voice: state.voice || [], game: gameView(state.game, uid) };
}

/* -------------------------------- carroms --------------------------------- */

// Board is normalized 0..1000, center (500,500). Piece radius 18, striker 24.
export const CARROM = { SIZE: 1000, R: 18, STRIKER_R: 24, POCKET_R: 34, CENTER: 500 };

export function initialCarromPieces() {
	const c = CARROM.CENTER;
	const pieces = [{ id: 'q', color: 'q', x: c, y: c, pocketed: false }];
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
export function carromsApplyShot(game, uid, { positions = [], pocketed = [], strikerPocketed = false }) {
	if (game.result) throw httpError(409, 'Game is finished');
	const team = carromTeamOf(game, uid);

	const live = game.pieces.filter((p) => !p.pocketed);
	const liveIds = new Set(live.map((p) => p.id));
	const pocketedSet = new Set(pocketed);
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
	let queenPocketed = false;
	for (const id of pocketedSet) {
		const piece = game.pieces.find((p) => p.id === id);
		if (piece.color === 'q') queenPocketed = true;
		else {
			game.scores[piece.color] += 1;
			if (piece.color === team) ownPocketed++;
		}
	}

	// queen + cover (simplified): queen pends until the shooter pockets an own
	// piece in the same or their next shot; otherwise she returns to center.
	if (queenPocketed) {
		game.queenPocketedBy = team;
		game.coverPending = true;
	}
	if (game.coverPending && game.queenPocketedBy === team && ownPocketed > 0) {
		game.coverPending = false;
		game.scores[team] += 3; // queen covered
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

	// uncovered queen returns to center when the turn passes
	const continueTurn = ownPocketed > 0 && !foul;
	if (!continueTurn && game.coverPending) {
		const q = game.pieces.find((p) => p.color === 'q');
		q.pocketed = false;
		q.x = CARROM.CENTER;
		q.y = CARROM.CENTER;
		game.coverPending = false;
		game.queenPocketedBy = null;
	}
	if (!continueTurn) game.turnIdx = (game.turnIdx + 1) % game.players.length;

	// What the shot sounded like, for everyone who didn't take it. The shooter
	// runs the sim locally and hears each impact against their own animation;
	// opponents and spectators only ever receive this settled result, so without
	// it they watch a coin drop into a pocket in silence.
	game.lastEvent = {
		kind: 'shot',
		uid,
		pocketed: pocketedSet.size,
		queen: queenPocketed,
		foul
	};

	// end: a color fully pocketed (and queen settled)
	const queenDown = game.pieces.find((p) => p.color === 'q').pocketed;
	for (const color of ['w', 'b']) {
		const remaining = game.pieces.filter((p) => p.color === color && !p.pocketed).length;
		if (remaining === 0 && queenDown) game.result = color;
	}
	return { foul, continueTurn, queenPocketed };
}

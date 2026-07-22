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
			result: null
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

export function thiefDeal(game) {
	if (game.phase !== 'idle' && game.phase !== 'reveal') throw httpError(409, 'Draw already in progress');
	if (game.draw >= game.drawsTotal) throw httpError(409, 'All draws are done');
	if (game.phase === 'reveal' && Date.now() - (game.revealedAt || 0) < REVEAL_HOLD_MS) {
		throw httpError(409, 'Let everyone see the reveal first');
	}
	const roles = ['Thief', 'Police', ...ROLE_LADDER.slice(0, game.players.length - 2).map(([n]) => n)];
	const dealt = shuffled(roles);
	game.secret = {};
	game.players.forEach((uid, i) => (game.secret[uid] = dealt[i]));
	game.policeUid = Number(Object.keys(game.secret).find((u) => game.secret[u] === 'Police'));
	game.draw += 1;
	game.phase = 'guessing';
	game.lastResult = null;
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
	return {
		type: game.type,
		players: game.players,
		draw: game.draw,
		drawsTotal: game.drawsTotal,
		phase: game.phase,
		policeUid: game.policeUid,
		myRole: game.phase === 'guessing' && game.secret ? game.secret[uid] || null : null,
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

	// end: a color fully pocketed (and queen settled)
	const queenDown = game.pieces.find((p) => p.color === 'q').pocketed;
	for (const color of ['w', 'b']) {
		const remaining = game.pieces.filter((p) => p.color === color && !p.pocketed).length;
		if (remaining === 0 && queenDown) game.result = color;
	}
	return { foul, continueTurn, queenPocketed };
}

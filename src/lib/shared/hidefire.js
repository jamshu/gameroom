// Hide & Fire — team combat round logic (teams, hits, last-team-standing win).
//
// ISOMORPHIC, dependency-free: runs in the DO, the route handlers and node
// checks — same rule everywhere, like the other shared/*.js game modules. No
// `$lib`, no `$env`.
//
// SPLIT OF CONCERNS: this file owns only the SLOW, durable plane — who is on
// which team, who's alive, who scored, and how long the round runs. Every
// player's position/aim/camo colour is the FAST plane and never touches state:
// it is relayed ephemerally through the DO's `move` frame, exactly like the
// carroms aim cursor. So there are no coordinates here on purpose.
//
// THE GAME: two teams (A and B), 1–4 players each. Everyone shoots and everyone
// dies — one hit is a kill, no respawn. The last team with anyone standing wins.
// The clock is only a safety cap: if it runs out, the team with more survivors
// wins (equal ⇒ a draw).

export const ROUND_MS = 180_000; // 3-minute safety cap; rounds usually end sooner

/**
 * Split players into two balanced teams by join index: even → A, odd → B. This
 * gives one of each for 2 players and an even 4-vs-4 for 8, and never leaves a
 * team empty for 2+ players (which the win check relies on).
 */
export function assignTeams(players) {
	const teams = {};
	players.forEach((u, i) => {
		teams[u] = i % 2 === 0 ? 'A' : 'B';
	});
	return teams;
}

/**
 * Fresh round state. `prev` = the previous round's team map, reused as-is —
 * teams do NOT swap between rounds (this is a deathmatch, not hide-and-seek).
 */
export function initHideFire(players, prev = null, now = Date.now()) {
	return {
		type: 'hidefire',
		players: [...players],
		teams: prev ? { ...prev } : assignTeams(players),
		phase: 'playing',
		startedAt: now,
		endsAt: now + ROUND_MS,
		// Everyone can die; keyed on every player so a client can render a puppet as
		// dead without a lookup miss.
		alive: Object.fromEntries(players.map((u) => [u, true])),
		scores: Object.fromEntries(players.map((u) => [u, 0])),
		result: null // 'A' | 'B' | 'draw' once resolved
	};
}

const teamOf = (game, u) => game.teams?.[u];
const teamAlive = (game, team) =>
	game.players.filter((u) => teamOf(game, u) === team && game.alive[u]).length;

/**
 * Client-authoritative kill: the shooter's raycast decided it, we record it.
 * // ponytail: no server hit validation — casual game, shooter trusted; add a
 * // position cross-check here if cheating ever matters.
 * Rejected if the round is over, the victim is already dead or unknown, the
 * shooter is dead, or the shooter is on the victim's own team (no friendly fire —
 * enforced HERE so a doctored client can't team-kill; the Godot ray does not
 * filter teammates, it only names who it hit).
 */
export function applyHit(game, victimUid, shooterUid = null) {
	if (game.result) return { killed: false };
	if (!game.alive[victimUid]) return { killed: false };
	if (shooterUid != null) {
		if (!game.alive[shooterUid]) return { killed: false };
		if (teamOf(game, shooterUid) === teamOf(game, victimUid)) return { killed: false };
	}
	game.alive[victimUid] = false;
	return { killed: true };
}

/**
 * Decide the round if it's decidable, award the point once, and freeze it.
 * A team is out the instant it has nobody left alive; the other team wins. If the
 * clock runs out with both teams standing, the team with more survivors wins
 * (equal ⇒ draw). Idempotent — a second call after the result is set does
 * nothing, so it's safe to run on every hit and on the timeout poke alike.
 */
export function resolve(game, now = Date.now()) {
	if (game.result) return game.result;
	const a = teamAlive(game, 'A');
	const b = teamAlive(game, 'B');
	let winner = null;
	if (a === 0 && b === 0) winner = 'draw'; // simultaneous wipe
	else if (a === 0) winner = 'B';
	else if (b === 0) winner = 'A';
	else if (now >= game.endsAt) winner = a > b ? 'A' : b > a ? 'B' : 'draw';
	if (!winner) return null;
	game.result = winner;
	game.phase = 'ended';
	if (winner !== 'draw') {
		for (const u of game.players) if (teamOf(game, u) === winner) game.scores[u] += 1;
	}
	return winner;
}

/** Next round: same teams, carry the running score across, everyone revived. */
export function nextRound(game, now = Date.now()) {
	const next = initHideFire(game.players, game.teams, now);
	next.scores = { ...game.scores };
	return next;
}

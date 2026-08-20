// Hide & Fire — round logic (roles, hits, win, next-round switch).
//
// ISOMORPHIC, dependency-free: runs in the DO, the route handlers and node
// checks — same rule everywhere, like the other shared/*.js game modules. No
// `$lib`, no `$env`.
//
// SPLIT OF CONCERNS: this file owns only the SLOW, durable plane — who hides,
// who seeks, who's alive, who scored, and how long the round runs. Every
// player's position/aim/camo colour is the FAST plane and never touches state:
// it is relayed ephemerally through the DO's `move` frame, exactly like the
// carroms aim cursor. So there are no coordinates here on purpose.

export const ROUND_MS = 90_000; // 90-second round, per the brief.

/**
 * Assign hider/seeker to each player.
 *
 * First round (no `prev`): even join-index hides, odd seeks — so 2 players give
 * one of each and it generalises to N-vs-N later without changing callers.
 * Next round (`prev` given): flip every player's role — the "teams switch" rule.
 */
export function assignRoles(players, prev = null) {
	const roles = {};
	players.forEach((u, i) => {
		if (prev && prev[u]) roles[u] = prev[u] === 'hider' ? 'seeker' : 'hider';
		else roles[u] = i % 2 === 0 ? 'hider' : 'seeker';
	});
	return roles;
}

/** Fresh round state. `prev` = last round's role map, to swap sides. */
export function initHideFire(players, prev = null, now = Date.now()) {
	return {
		type: 'hidefire',
		players: [...players],
		roles: assignRoles(players, prev),
		phase: 'playing',
		startedAt: now,
		endsAt: now + ROUND_MS,
		// Only hiders can die; seekers are alive by definition. Keyed on every
		// player so the client can render a puppet as dead without a lookup miss.
		alive: Object.fromEntries(players.map((u) => [u, true])),
		scores: Object.fromEntries(players.map((u) => [u, 0])),
		result: null // 'seekers' | 'hiders' once resolved
	};
}

const isHider = (game, u) => game.roles[u] === 'hider';

/**
 * Client-authoritative kill: the shooter's raycast decided it, we record it.
 * // ponytail: no server hit validation — casual game, shooter trusted; add a
 * // position cross-check here if cheating ever matters.
 * A seeker cannot be shot, an already-dead hider cannot be re-killed, and a
 * finished round takes no more hits.
 */
export function applyHit(game, victimUid) {
	if (game.result) return { killed: false };
	if (!isHider(game, victimUid) || !game.alive[victimUid]) return { killed: false };
	game.alive[victimUid] = false;
	return { killed: true };
}

/** Everyone whose role is `hider`. */
const hiders = (game) => game.players.filter((u) => isHider(game, u));

/**
 * Decide the round if it's decidable, award the point once, and freeze it.
 * Seekers win the instant no hider is left alive; hiders win when the clock
 * runs out with any of them still standing. Idempotent — a second call after
 * the result is set does nothing, so it's safe to run on every hit and on the
 * host's timeout poke alike.
 */
export function resolve(game, now = Date.now()) {
	if (game.result) return game.result;
	const alive = hiders(game).filter((u) => game.alive[u]);
	let winners = null;
	if (alive.length === 0) winners = 'seekers';
	else if (now >= game.endsAt) winners = 'hiders';
	if (!winners) return null;
	game.result = winners;
	game.phase = 'ended';
	for (const u of game.players) {
		if ((winners === 'hiders') === isHider(game, u)) game.scores[u] += 1;
	}
	return winners;
}

/** Next round: swap sides, carry the running score across. */
export function nextRound(game, now = Date.now()) {
	const next = initHideFire(game.players, game.roles, now);
	next.scores = { ...game.scores };
	return next;
}

// Ludo movement rules. Pure — no browser and no Odoo dependency — so the board
// component and $lib/server/gamelogic.js both import it rather than keeping two
// copies, the way $lib/games.js is shared.
//
// That sharing is the point, not a tidy-up. LudoBoard used to hand-copy the
// legality rule (with 56 and 6 inlined) purely to decide which tokens glow, and
// it also AUTO-PLAYS a forced move off that copy. The moment the two definitions
// disagreed, the client would post a move the server answers with
// 400 "That token cannot move" — a bug with no visible cause. One definition,
// imported twice, makes that impossible.

/**
 * Token position encoding (per token, per player):
 *   -1        in the yard (not yet entered)
 *   0..50     on the shared main track, RELATIVE to the player's own start cell
 *             (0 = start). Absolute board cell = (LUDO_START_OFFSET[color] + pos) % 52.
 *   51..56    the player's private 6-cell home column; 56 is the final home (exact).
 * A token needs a 6 to leave the yard, and an exact roll to land on 56.
 */
export const LUDO_COLORS = ['red', 'green', 'yellow', 'blue'];
export const LUDO_START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
export const LUDO_TRACK = 52; // shared ring length
export const LUDO_HOME = 56; // final (exact) position
// The 8 star safe cells (absolute): the four coloured start cells + four mid-arm
// stars. A token sitting on one of these can't be captured.
export const LUDO_SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** Absolute ring cell for a main-track token, or null if it's in yard/home column. */
export function ludoAbsCell(color, pos) {
	if (pos < 0 || pos > 50) return null;
	return (LUDO_START_OFFSET[color] + pos) % LUDO_TRACK;
}

/**
 * Ring cells `uid` may not enter or cross: those where a SINGLE opponent has two
 * or more tokens together. Two of one colour on a cell is a wall.
 *
 * Counted per opponent, never in aggregate. A safe cell can hold one red and one
 * yellow at once — two tokens, two owners, no wall for anybody. Summing them
 * would invent blocks that don't exist.
 *
 * Safe/star cells are NOT exempt: a block is a block anywhere. That includes a
 * player's own start cell, so two tokens parked there leave an opponent whose
 * four tokens are all in the yard with no legal move at all, turn after turn.
 * `ludoRoll` auto-passes them. It isn't a permanent deadlock — the blocker has
 * to move those tokens eventually to finish — but nothing here prevents a
 * spiteful player stalling, and there is no draw or turn limit in this game.
 */
export function ludoBlockedCells(game, uid) {
	const blocked = new Set();
	for (const other of game.players) {
		if (other === uid) continue;
		const color = game.colors[other];
		const seen = new Map();
		for (const pos of game.tokens[other] || []) {
			const abs = ludoAbsCell(color, pos);
			if (abs == null) continue; // yard or a private home column
			const n = (seen.get(abs) || 0) + 1;
			seen.set(abs, n);
			if (n >= 2) blocked.add(abs);
		}
	}
	return blocked;
}

/**
 * Legal moves for `uid` given `dice`, as [{ token, target }]. PURE.
 *
 * Yard tokens move only on a 6; a board token moves only if it lands exactly on
 * or before home (pos+dice <= 56 — overshoots are illegal). Own-stacking is
 * allowed. An opponent's block stops a token dead: it may neither land on that
 * cell nor pass over it.
 */
export function ludoLegalMoves(game, uid, dice) {
	const toks = game.tokens[uid] || [];
	const color = game.colors?.[uid];
	const blocked = ludoBlockedCells(game, uid);
	const moves = [];
	for (let i = 0; i < toks.length; i++) {
		const pos = toks[i];
		if (pos === LUDO_HOME) continue; // already finished
		if (pos === -1) {
			// Entering skips the pos+dice path entirely, so it needs its own landing
			// check — a block sitting on our start cell keeps us in the yard.
			if (dice === 6 && !blocked.has(ludoAbsCell(color, 0))) moves.push({ token: i, target: 0 });
			continue;
		}
		const target = pos + dice;
		if (target > LUDO_HOME) continue;
		// Every ring cell we'd cross OR land on. ludoAbsCell returns null past 50,
		// so the private home column drops out on its own — no separate case.
		let clear = true;
		for (let p = pos + 1; p <= target; p++) {
			const abs = ludoAbsCell(color, p);
			if (abs != null && blocked.has(abs)) {
				clear = false;
				break;
			}
		}
		if (clear) moves.push({ token: i, target });
	}
	return moves;
}

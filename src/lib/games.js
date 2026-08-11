// The four games, in one place. Ids, labels and player requirements used to be
// re-spelled in every select, chip and validation list; a room can now switch
// game type at runtime, so they all have to agree.
//
// Pure data — no browser or Odoo dependency — so $lib/server modules import it
// too rather than keeping a second copy of the id list.
export const GAMES = [
	{ id: 'thief_finder', label: 'Thief Finder', emoji: '🕵️', needs: 'at least 3 players' },
	{ id: 'chess', label: 'Chess', emoji: '♟️', needs: 'exactly 2 players' },
	{ id: 'carroms', label: 'Carroms', emoji: '🎯', needs: '2 or 4 players' },
	{ id: 'ludo', label: 'Ludo', emoji: '🎲', needs: '2 to 4 players' },
	{ id: 'videocall', label: 'Video Call', emoji: '📹', needs: '2 to 6 players' },
	// The two race games: everyone plays their OWN board from one shared deal,
	// simultaneously, rather than taking turns. Also the only two with a
	// local-only solo mode (/solo/*), which needs no room at all.
	{ id: 'sudoku', label: 'Sudoku', emoji: '🔢', needs: '2 to 6 players' },
	{ id: 'match3', label: 'Candy Match', emoji: '🍬', needs: '2 to 6 players' }
];

export const GAME_TYPES = GAMES.map((g) => g.id);

/** Falls back to the first game so an unknown id renders rather than crashing. */
export const gameById = (id) => GAMES.find((g) => g.id === id) ?? GAMES[0];

export const gameLabel = (id) => `${gameById(id).emoji} ${gameById(id).label}`;

/**
 * How many accepted members can hold `role='player'`; the rest are spectators.
 * Keyed on the game type rather than a room, because the game-type switch asks
 * about a type the room doesn't have yet — and the lobby previews the answer
 * before posting, so both sides must compute it identically.
 */
export function playerCapacity(gameType, maxPlayers) {
	if (gameType === 'chess') return 2;
	if (gameType === 'carroms') return 4;
	if (gameType === 'ludo') return 4;
	if (gameType === 'videocall') return 6;
	// Race games have no structural seat limit — every player has their own
	// board — so the cap is about the rival ticker staying readable, not rules.
	if (gameType === 'sudoku') return 6;
	if (gameType === 'match3') return 6;
	return maxPlayers || 10;
}

/**
 * Which accepted members hold a player seat under `gameType` — the first
 * `playerCapacity` by join order (lowest member id, so the host, always the
 * first row, keeps their seat). Everyone else spectates.
 *
 * Takes `[{ id, accepted }]` rather than raw rows so the server (Odoo field
 * names) and the lobby preview (client field names) can share one rule instead
 * of each re-deriving it and drifting.
 */
export function seatedPlayerIds(members, gameType, maxPlayers) {
	const seats = members
		.filter((m) => m.accepted)
		.sort((a, b) => a.id - b.id)
		.slice(0, playerCapacity(gameType, maxPlayers));
	return new Set(seats.map((m) => m.id));
}

/* ------------------------- contended-phase ordering -------------------------
   Thief-finder `picking` is the one place several players write at the same
   instant — everyone grabs an envelope at once — whereas chess, ludo and carroms
   only ever accept a write from the player whose turn it is. Two writers reading
   the same `state.v` both persist v+1 with DIFFERENT content, and the version
   gates on both sides then drop one of them with no way back (see writeState's
   guardVersion and the store's mergeState).

   The escape hatch is to let equal versions through and order them by progress
   instead. That tiebreak has to be a TOTAL order or it makes things worse: rank
   by "different content" alone and the losing `picking` payload would overwrite
   the winning `guessing` one, walking the room backwards.

   Lives here, in the shared dependency-free module, because the poll endpoint
   and the client store must agree exactly — the server relaxing its gate without
   the client relaxing its own would just send bytes nobody applies. Works on the
   raw server game AND on the filtered `thiefView` a client holds; `claims` is
   nulled outside `picking` by that filter, which the ranking below relies on. */

const PHASE_RANK = { picking: 0, guessing: 1 };

/**
 * How far a contended thief-finder game has progressed, as a single comparable
 * number — or `null` when equal-version ordering doesn't apply (any other game,
 * or a phase only a single writer can reach).
 *
 * Within `picking`, more envelopes claimed is strictly later: `resolveClaims`
 * rebuilds from an append-only log, so a fuller claim map means a fuller log.
 * The phase step dominates the claim count by construction — a room can't hold
 * 1000 players — so the guessing flip always outranks any picking payload.
 */
export function contendedProgress(game) {
	/* DELIBERATELY thief_finder only — do not add sudoku or match3 here.
	   They look like candidates (several players writing at once) but the
	   conflict is the opposite shape. Thief-finder's writers contend for the SAME
	   bytes and produce genuinely different room futures, so one of them has to
	   be ranked the winner; that is what this total order is for. In a race every
	   player writes only their own sub-state under `boards[uid]`/`scores[uid]`,
	   so two writes never describe conflicting futures and there is nothing to
	   rank — they are merged instead, by a per-player DO op (see sudokuFill in
	   do/room-do.js, modelled on thiefPick). Extending the ranking to cover them
	   would put two more games inside this invariant for no gain. */
	if (game?.type !== 'thief_finder') return null;
	const rank = PHASE_RANK[game.phase];
	if (rank == null) return null;
	return rank * 1000 + Object.keys(game.claims || {}).length;
}

/** Is this game in a phase where equal versions must still be compared? */
export const isContendedPhase = (game) => contendedProgress(game) !== null;

/**
 * At an EQUAL state version, is `incoming` genuinely later than `held`?
 *
 * The store's mergeState asks this after its strict `<` check. Lives here rather
 * than as a closure in the store so the edges are assertable: `held` may be
 * absent (nothing to lose), and an unrankable held phase — reveal, finished — is
 * NOT a licence to overwrite, since those are strictly later than anything this
 * ranks and would otherwise be walked backwards by a stale `picking` payload.
 */
export function outranksAtSameVersion(held, incoming) {
	const next = contendedProgress(incoming);
	if (next == null) return false;
	if (!held) return true;
	const now = contendedProgress(held);
	return now != null && next > now;
}

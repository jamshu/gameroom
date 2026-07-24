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
	{ id: 'ludo', label: 'Ludo', emoji: '🎲', needs: '2 to 4 players' }
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

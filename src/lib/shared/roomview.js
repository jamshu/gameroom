// Odoo row -> client shape. Pure, and deliberately $env-free: the room Durable
// Object serves the same room/roster payloads the HTTP routes do, and it is
// bundled outside the SvelteKit build. `check:noenv` enforces that.
//
// One definition, two callers. If the DO shaped rooms even slightly differently
// from the routes, the difference would show up as a UI flicker whenever a
// client switched transports — the hardest kind of bug to attribute.

/**
 * How stale `last_seen` may get before a member renders offline.
 *
 * Only meaningful on the HTTP path. The DO knows exactly which sockets are open
 * and overrides `online` from that, so this window is a fallback, not the
 * source of truth, for a DO-backed room.
 */
export const PRESENCE_WINDOW_MS = 90000;

/* A room is private only when it says so. x_studio_visibility is NULL on every
   row created before the field existed, so "not private" is the safe reading of
   anything else — never test for 'public'. */
export function isPrivateRow(room) {
	return room?.x_studio_visibility === 'private';
}

export function publicRoom(room) {
	return {
		id: room.id,
		name: room.x_name,
		gameType: room.x_studio_game_type,
		status: room.x_studio_status,
		hostUid: room.x_studio_host_id?.[0],
		hostName: room.x_studio_host_id?.[1],
		maxPlayers: room.x_studio_max_players,
		drawsTotal: room.x_studio_draws_total,
		// the 🔒 chip. The allowed-uid list is deliberately NOT here: this ships on
		// every roster push and poll, and turning uids into names costs an extra
		// res.users read. The host fetches the guest list from `invites` instead.
		visibility: isPrivateRow(room) ? 'private' : 'public'
	};
}

export function publicMembers(members) {
	const now = Date.now();
	return members
		.filter((m) => m.x_studio_status !== 'rejected')
		.map((m) => ({
			id: m.id,
			uid: m.x_studio_user_id?.[0],
			name: m.x_studio_user_id?.[1] || m.x_name,
			status: m.x_studio_status,
			role: m.x_studio_role,
			score: m.x_studio_score || 0,
			online:
				!!m.x_studio_last_seen &&
				now - new Date(m.x_studio_last_seen.replace(' ', 'T') + 'Z').getTime() < PRESENCE_WINDOW_MS
		}));
}

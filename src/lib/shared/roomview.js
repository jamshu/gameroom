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
 * The FALLBACK half of presence, not the whole of it. A player holding a socket
 * is online the instant they connect and offline the instant it closes; this
 * window only answers for players on the HTTP path, whose poll heartbeat is the
 * only evidence they exist.
 */
export const PRESENCE_WINDOW_MS = 90000;

/**
 * Is this member online? A UNION, and it has to be.
 *
 * Socket alone would render every HTTP-fallback player offline — including to
 * themselves — and last_seen alone is what made the lobby dot lag by up to 90
 * seconds after somebody actually left. Either signal is sufficient; neither is
 * necessary.
 *
 * One function so the object and the routes cannot answer differently. They ship
 * the same field on the same wire (`roster` frames and the poll envelope both
 * carry `online`), so a disagreement renders as a dot that flickers when a client
 * changes transport — which is close to unattributable.
 */
export function isOnline(uid, lastSeen, liveUids = null, now = Date.now()) {
	if (liveUids?.has(uid)) return true;
	return !!lastSeen && now - lastSeen < PRESENCE_WINDOW_MS;
}

/** Odoo's datetime string -> epoch ms, or 0. Odoo omits the zone; it is UTC. */
export function lastSeenMs(row) {
	const s = row?.x_studio_last_seen;
	return s ? new Date(s.replace(' ', 'T') + 'Z').getTime() : 0;
}

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

/**
 * `liveUids` — the uids holding a socket right now, when the caller knows them.
 *
 * `lastSeen` rides along in the output ON PURPOSE. Without it `online` is a
 * verdict frozen at the moment the roster was built, and the object stores that
 * roster and re-serves it for as long as the room lives: a member who was online
 * when the last roster was pushed would render online forever. Carrying the raw
 * timestamp lets any later reader re-decide instead of inheriting a stale answer.
 */
export function publicMembers(members, liveUids = null) {
	const now = Date.now();
	return members
		.filter((m) => m.x_studio_status !== 'rejected')
		.map((m) => {
			const uid = m.x_studio_user_id?.[0];
			const lastSeen = lastSeenMs(m);
			return {
				id: m.id,
				uid,
				name: m.x_studio_user_id?.[1] || m.x_name,
				status: m.x_studio_status,
				role: m.x_studio_role,
				score: m.x_studio_score || 0,
				lastSeen,
				online: isOnline(uid, lastSeen, liveUids, now)
			};
		});
}

/**
 * Re-decide presence over an ALREADY-PUBLIC roster.
 *
 * The object stores `publicMembers` output and hands it out on every welcome,
 * roster frame and snapshot. Those are served minutes or hours after the roster
 * was built, so the stored `online` is worthless by then — this recomputes from
 * the `lastSeen` that travelled with the row, unioned with who is connected now.
 */
export function withPresence(publicRows, liveUids, now = Date.now()) {
	return (publicRows ?? []).map((m) => ({
		...m,
		online: isOnline(m.uid, m.lastSeen, liveUids, now)
	}));
}

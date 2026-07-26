import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { ROOM, MEMBER, GAME_TYPES, browseDomain, sweepAbandonedRooms, jsonError } from '$lib/server/room.js';

export const prerender = false;

/** Create a room; creator becomes host + accepted player. */
export async function POST({ request, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const { name, gameType, maxPlayers, drawsTotal, visibility, allowedUids } = await request.json();
		if (!name?.trim()) return json({ ok: false, error: 'Room name is required' }, { status: 400 });
		if (!GAME_TYPES.includes(gameType)) return json({ ok: false, error: 'Pick a game' }, { status: 400 });
		if (gameType === 'thief_finder' && ![5, 10].includes(Number(drawsTotal))) {
			return json({ ok: false, error: 'Choose 5 or 10 draws' }, { status: 400 });
		}
		if (visibility && !['public', 'private'].includes(visibility)) {
			return json({ ok: false, error: 'Invalid visibility' }, { status: 400 });
		}
		const priv = visibility === 'private';
		// The host goes on their own guest list — the browse domain filters private
		// rooms by that list, so leaving them off would hide the room from its owner.
		const guests = priv
			? [...new Set([uid, ...(Array.isArray(allowedUids) ? allowedUids : [])
				.map(Number).filter(Number.isInteger)])]
			: [];

		const roomId = await adminExecute(ROOM, 'create', [{
			x_name: name.trim(),
			x_studio_game_type: gameType,
			x_studio_status: 'lobby',
			x_studio_host_id: uid,
			x_studio_max_players: Number(maxPlayers) || 8,
			x_studio_draws_total: gameType === 'thief_finder' ? Number(drawsTotal) : 0,
			x_studio_state: JSON.stringify({ v: 0, voice: [], game: null }),
			x_studio_visibility: priv ? 'private' : 'public',
			...(priv ? { x_studio_allowed_user_ids: [[6, 0, guests]] } : {})
		}]);
		await adminExecute(MEMBER, 'create', [{
			x_name: String(uid),
			x_studio_room_id: roomId,
			x_studio_user_id: uid,
			x_studio_status: 'accepted',
			x_studio_role: 'player'
		}]);
		return json({ ok: true, roomId });
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

/**
 * Browse open rooms. Newest first; `q` is an optional name search.
 *
 * The client caches a page of these and filters in memory as you type, so this
 * is hit once on load rather than once per keystroke — Odoo Online's rate limit
 * is per-IP and shared by every player in every room.
 *
 * Private rooms are filtered here rather than after the fact: the uid used to be
 * discarded, and browseDomain is the ONE place that decides who can see what.
 */
export async function GET({ url, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		await sweepAbandonedRooms();
		const domain = browseDomain({
			uid,
			q: url.searchParams.get('q')?.trim() || '',
			type: url.searchParams.get('type') || '',
			status: url.searchParams.get('status') || ''
		});
		const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 50);

		const rooms = await adminExecute(ROOM, 'search_read', [domain,
			['x_name', 'x_studio_game_type', 'x_studio_status', 'x_studio_host_id',
				'x_studio_max_players', 'x_studio_visibility']
		], { order: 'id desc', limit });
		return json({
			ok: true,
			rooms: rooms.map((r) => ({
				id: r.id,
				name: r.x_name,
				gameType: r.x_studio_game_type,
				status: r.x_studio_status,
				hostName: r.x_studio_host_id?.[1] || '',
				// already fetched from Odoo and previously discarded — free to expose
				maxPlayers: r.x_studio_max_players || 0,
				visibility: r.x_studio_visibility === 'private' ? 'private' : 'public'
			}))
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

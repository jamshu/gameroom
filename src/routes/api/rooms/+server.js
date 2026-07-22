import { json } from '@sveltejs/kit';
import { adminExecute } from '$lib/server/odoo.js';
import { requireUser } from '$lib/server/auth.js';
import { ROOM, MEMBER, jsonError } from '$lib/server/room.js';

export const prerender = false;

const GAME_TYPES = ['chess', 'carroms', 'thief_finder'];

/** Create a room; creator becomes host + accepted player. */
export async function POST({ request, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const { name, gameType, maxPlayers, drawsTotal } = await request.json();
		if (!name?.trim()) return json({ ok: false, error: 'Room name is required' }, { status: 400 });
		if (!GAME_TYPES.includes(gameType)) return json({ ok: false, error: 'Pick a game' }, { status: 400 });
		if (gameType === 'thief_finder' && ![5, 10].includes(Number(drawsTotal))) {
			return json({ ok: false, error: 'Choose 5 or 10 draws' }, { status: 400 });
		}

		const roomId = await adminExecute(ROOM, 'create', [{
			x_name: name.trim(),
			x_studio_game_type: gameType,
			x_studio_status: 'lobby',
			x_studio_host_id: uid,
			x_studio_max_players: Number(maxPlayers) || 8,
			x_studio_draws_total: gameType === 'thief_finder' ? Number(drawsTotal) : 0,
			x_studio_state: JSON.stringify({ v: 0, voice: [], game: null })
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

/** Search open rooms by name. */
export async function GET({ url, cookies }) {
	try {
		await requireUser(cookies);
		const q = url.searchParams.get('q')?.trim() || '';
		const domain = [['x_studio_status', '!=', 'finished']];
		if (q) domain.push(['x_name', 'ilike', q]);
		const rooms = await adminExecute(ROOM, 'search_read', [domain,
			['x_name', 'x_studio_game_type', 'x_studio_status', 'x_studio_host_id', 'x_studio_max_players']
		], { order: 'id desc', limit: 30 });
		return json({
			ok: true,
			rooms: rooms.map((r) => ({
				id: r.id,
				name: r.x_name,
				gameType: r.x_studio_game_type,
				status: r.x_studio_status,
				hostName: r.x_studio_host_id?.[1] || ''
			}))
		});
	} catch (e) {
		const { body, status } = jsonError(e);
		return json(body, { status });
	}
}

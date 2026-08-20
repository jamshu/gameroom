import { json } from '@sveltejs/kit';
import { requireMemberCached } from '$lib/server/room.js';
import { publishMove } from '$lib/server/realtime.js';

// Ephemeral: broadcast one player's live transform (position, yaw/pitch, camo
// colour, alive) so peers can render the moving puppet. No state write, no event
// — kills and the round result travel the durable state path instead.
//
// Hot path: fires ~15x/sec per player. MUST use the cached membership read — the
// uncached requireMember does two Odoo fetches per call, which at this cadence
// rate-limits the whole app (429). Mirror of carroms/aim.
export async function POST({ params, cookies, request }) {
	// `state: false`: this route never touches the state blob, so skip the DO
	// overlay requireMemberCached would otherwise apply to fetch a discarded field.
	const { uid } = await requireMemberCached(cookies, params.id, { state: false });
	const data = await request.json();
	await publishMove(params.id, { ...data, uid });
	return json({ ok: true });
}

import { json } from '@sveltejs/kit';
import { requireMemberCached } from '$lib/server/room.js';
import { publishAim } from '$lib/server/realtime.js';

// Ephemeral: broadcast the shooter's live striker position + aim vector to the
// room so everyone sees them line up the shot. No state write, no event — the
// receiver renders only the current player's cursor, so nothing durable rides
// on this.
//
// Hot path: fires ~10x/sec while a player aims. MUST use the cached membership
// read — the uncached requireMember does two Odoo fetches per call, which at this
// cadence rate-limits the whole app (429). requireMemberCached serves from the
// same 750ms snapshot the poll already warms.
export async function POST({ params, cookies, request }) {
	// `state: false` for the same reason the cached read is used at all: this route
	// never touches the state blob, and at ~10 calls/second the Durable Object
	// overlay requireMemberCached otherwise applies would double this path's object
	// traffic to fetch a field that is immediately discarded.
	const { uid } = await requireMemberCached(cookies, params.id, { state: false });
	const { strikerT, aim } = await request.json();
	await publishAim(params.id, { uid, strikerT, aim });
	return json({ ok: true });
}

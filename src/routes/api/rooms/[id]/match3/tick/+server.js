import { json } from '@sveltejs/kit';
import { requireMemberCached } from '$lib/server/room.js';
import { publishTick } from '$lib/server/realtime.js';

// Ephemeral: broadcast a player's running match-3 score so the rest of the room
// sees the race move. No state write, no event, no version bump — the score that
// counts is reported once at the finish, through match3/finish, and is clamped
// there. Nothing durable rides on this, so a dropped tick costs a stale number
// for a second and nothing else.
//
// Hot path, exactly like carroms/aim: every player sends one every couple of
// seconds for the 90 seconds a round lasts. It MUST use the cached membership
// read — the uncached requireMember does two Odoo fetches per call, which at
// this cadence rate-limits the whole app (429). `state: false` for the same
// reason it is there: this route never looks at the state blob, so fetching the
// Durable Object overlay would double its object traffic for a field that is
// thrown away.
export async function POST({ params, cookies, request }) {
	const { uid } = await requireMemberCached(cookies, params.id, { state: false });
	const { score } = await request.json();
	await publishTick(params.id, { uid, score: Math.max(0, Math.floor(Number(score) || 0)) });
	return json({ ok: true });
}

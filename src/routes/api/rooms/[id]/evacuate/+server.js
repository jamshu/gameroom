import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { doOp } from '$lib/server/dostub.js';

export const prerender = false;

/**
 * THE M2.4 ROLLBACK. Hand one room back from its Durable Object to the Odoo
 * path, per room, without a deploy.
 *
 * M2.4 is the first stage where a bug corrupts durable game state, so this has
 * to exist BEFORE ownership moves, not after. `DO_ROOMS=off` is M2.3's rollback
 * and is NOT a substitute here: flipping the flag on a room the object already
 * owns would strand up to one archive period of state inside an object nothing
 * talks to any more, and routes would immediately start writing Odoo underneath
 * it. Evacuate first, then flip the flag if you want to.
 *
 * The object refuses to complete until its flush succeeds (see RoomDO.evacuate),
 * which is what makes this a rollback rather than a data-loss button. A non-ok
 * reply means the room is still on the object and still playable — retry it.
 *
 * Guarded by CRON_SECRET rather than a new secret of its own, deliberately: this
 * is an incident tool, and needing to provision a secret before you can use it
 * is exactly the wrong property. Same constant-time-ish comparison as the sweep.
 */
export async function POST({ params, request }) {
	const expected = env.CRON_SECRET;
	if (!expected) {
		console.error('evacuate: CRON_SECRET is not set — refusing to run');
		return json({ ok: false, error: 'Not configured' }, { status: 503 });
	}
	const got = request.headers.get('x-cron-secret') || '';
	let diff = got.length ^ expected.length;
	for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i % expected.length);
	if (diff !== 0) return json({ ok: false, error: 'Not found' }, { status: 404 });

	// Deliberately NOT gated on isDoRoom: the flag may already have been flipped
	// off in a panic, and that is precisely when the object still holds state that
	// has to be flushed.
	const res = await doOp(params.id, { op: 'evacuate' });
	if (!res) return json({ ok: false, error: 'The room object did not answer' }, { status: 503 });
	console.log(`evacuate room ${params.id}: ${JSON.stringify(res)}`);
	return json(res, { status: res.ok ? 200 : 409 });
}

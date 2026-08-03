import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { roomStub } from '$lib/server/dostub.js';

export const prerender = false;

/**
 * Read one room object's internals. The operator's window into a DO.
 *
 * Everything an object does that matters happens on an alarm nobody is watching:
 * whether it owns the state, how long its write-behind has been failing, how
 * much is still owed to Odoo. Without this the only way to answer "why is this
 * room misbehaving" is `wrangler tail` and inference — which is how a run of
 * orphaned objects retried Odoo for an hour before anyone noticed.
 *
 * Same CRON_SECRET gate as the sweep and evacuate: this exposes room internals
 * and must not be public, and an incident tool that needs a new secret
 * provisioned before it can be used is the wrong tool.
 *
 * Deliberately NOT gated on isDoRoom — an object that should not be running is
 * exactly the one worth inspecting.
 */
export async function GET({ params, request, url }) {
	const expected = env.CRON_SECRET;
	if (!expected) return json({ ok: false, error: 'Not configured' }, { status: 503 });
	const got = request.headers.get('x-cron-secret') || url.searchParams.get('s') || '';
	let diff = got.length ^ expected.length;
	for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i % expected.length);
	if (diff !== 0) return json({ ok: false, error: 'Not found' }, { status: 404 });

	const stub = roomStub(params.id);
	if (!stub) return json({ ok: false, error: 'no ROOM binding' }, { status: 503 });
	const res = await stub.fetch('https://do/health', {
		headers: { 'x-room-id': String(Number(params.id)) }
	});
	return json(await res.json(), { status: res.status });
}

/**
 * Destroy one room's object outright. The manual counterpart to the self-heal.
 *
 * DIFFERENT FROM EVACUATE, and the difference is the whole point: evacuate
 * FLUSHES and hands the room back, and refuses if it cannot. This DISCARDS. It
 * is for an object whose room no longer exists in Odoo, where there is nothing
 * to flush to and the flush is precisely what cannot succeed — the state that
 * makes evacuate refuse forever.
 *
 * Never reach for this on a live room; that is what evacuate is for. Here it
 * exists because the self-heal only runs when an object's alarm happens to fire,
 * and an operator staring at a bad object should not have to wait for that.
 */
export async function DELETE({ params, request, url }) {
	const expected = env.CRON_SECRET;
	if (!expected) return json({ ok: false, error: 'Not configured' }, { status: 503 });
	const got = request.headers.get('x-cron-secret') || url.searchParams.get('s') || '';
	let diff = got.length ^ expected.length;
	for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i % expected.length);
	if (diff !== 0) return json({ ok: false, error: 'Not found' }, { status: 404 });

	const stub = roomStub(params.id);
	if (!stub) return json({ ok: false, error: 'no ROOM binding' }, { status: 503 });
	const res = await stub.fetch('https://do/apply', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-room-id': String(Number(params.id)) },
		body: JSON.stringify({ op: 'destroy' })
	});
	console.log(`do-health DELETE: destroyed object for room ${params.id}`);
	return json(await res.json(), { status: res.status });
}

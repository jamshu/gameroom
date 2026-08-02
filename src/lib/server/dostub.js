// The Worker's side of the room Durable Object binding.
//
// Split out of realtime.js because it stopped being about push: since M2.4 the
// same stub carries the authoritative reads and writes (`snapshot`, `setState`,
// `append`, `events`), and leaving the plumbing inside a module named "realtime"
// would make room.js's dependency on it read as a push concern rather than the
// state-ownership one it is.
import { getRequestEvent } from '$app/server';

/**
 * The stub for a room's object, or null if we cannot reach the binding.
 *
 * The binding lives on the RequestEvent, and threading `platform` through the
 * ~25 call sites in room.js would be a far bigger diff than the feature.
 * getRequestEvent() reads it out of AsyncLocalStorage instead — which is exactly
 * why wrangler.toml needs nodejs_compat (SvelteKit's internal/event.js imports
 * node:async_hooks).
 */
export function roomStub(roomId) {
	// getRequestEvent throws outside a request (the cron path, module init), which
	// is a legitimate state rather than an error.
	let platform;
	try {
		({ platform } = getRequestEvent());
	} catch {
		return null;
	}
	const ns = platform?.env?.ROOM;
	if (!ns) return null;
	return ns.get(ns.idFromName(`room:${Number(roomId)}`), {
		locationHint: platform.env.DO_LOCATION_HINT || undefined
	});
}

/**
 * Send one op and return the object's reply, or null if it could not be reached.
 *
 * NULL AND `{ok:false}` MEAN DIFFERENT THINGS, and every caller has to keep them
 * apart:
 *
 *  - `null` — the object did not answer. It may still own the room's state, so a
 *    caller holding a write must FAIL rather than fall back to Odoo; writing
 *    behind an object that owns the room is the split brain the whole rollout
 *    plan exists to avoid.
 *  - `{ok:false, error:'evacuated'}` — the object has deliberately handed the
 *    room back and flushed everything it held. Falling back to Odoo is then not
 *    just safe, it is the point (see RoomDO.evacuate).
 *
 * Best-effort push callers (publish*) ignore both and swallow, which is correct
 * for them: the state is already persisted by the time they run.
 */
export async function doOp(roomId, op) {
	try {
		const stub = roomStub(roomId);
		if (!stub) {
			console.error(`doOp: no ROOM binding for room ${roomId} — op ${op?.op} dropped`);
			return null;
		}
		const res = await stub.fetch('https://do/apply', {
			method: 'POST',
			// x-room-id: the object cannot derive its own room from its id
			// (idFromName is one-way), and it needs it to reach Odoo on first touch.
			headers: { 'content-type': 'application/json', 'x-room-id': String(Number(roomId)) },
			body: JSON.stringify(op)
		});
		if (!res.ok) {
			console.error(`doOp ${op?.op} -> HTTP ${res.status}`);
			return null;
		}
		return await res.json();
	} catch (e) {
		console.error(`doOp ${op?.op} failed:`, e?.message);
		return null;
	}
}

/** True when the object answered "I have handed this room back". */
export const isEvacuated = (res) => res?.ok === false && res?.error === 'evacuated';

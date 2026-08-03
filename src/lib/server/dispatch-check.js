// check:dispatch — the four publish* names still funnel every push through one
// place, and the rollout flag still gates them.
//
// Replaces check:realtime, which asserted Ably channel names and that everything
// no-opped when ABLY_API_KEY was unset. Both questions died with M2.5. The one
// that survives is the seam itself: writeState, appendEvent and pushRoster route
// ~25 call sites through these four functions, and if the flag ever stopped
// gating them a room the operator had deliberately taken off the object would
// still be pushed at.
//
// Run: node --import ./src/lib/server/dispatch-stub-loader.mjs src/lib/server/dispatch-check.js
import assert from 'node:assert';
import { register } from 'node:module';
register('./dispatch-stub-loader.mjs', import.meta.url);
const { publishState, publishRoster, publishEvent, publishAim } = await import('./realtime.js');

const reset = () => { globalThis.__doOps = []; };

// --- the flag is off: nothing is dispatched, and nothing throws --------------
process.env.DO_ROOMS = 'off';
reset();
await assert.doesNotReject(publishState(5, { v: 3, game: null }), 'publishState never throws');
await assert.doesNotReject(publishRoster(5, { room: {}, members: [] }), 'publishRoster never throws');
await assert.doesNotReject(publishEvent(5, { id: 1, type: 'chat' }, 42), 'publishEvent never throws');
await assert.doesNotReject(publishAim(5, { uid: 1 }), 'publishAim never throws');
assert.equal(globalThis.__doOps.length, 0, 'a room outside the flag is never pushed at');

// --- the flag is on: each name maps to exactly one op ------------------------
process.env.DO_ROOMS = 'all';
reset();
await publishState(5, { v: 3, game: null });
await publishRoster(5, { room: { id: 5 }, members: [{ uid: 7 }] });
await publishEvent(5, { id: 1, type: 'chat' }, 42);
await publishAim(5, { uid: 1, strikerT: 0.5 });

assert.deepEqual(globalThis.__doOps.map((o) => o.op), ['state', 'roster', 'event', 'aim'],
	'four names, four ops, in order');
assert.equal(globalThis.__doOps.every((o) => o.roomId === 5), true, 'all addressed to the same room');

// The targeted-event contract: a WebRTC signal must carry its recipient, or the
// object would fan it out to the whole room and leak the offer to everyone.
assert.equal(globalThis.__doOps[2].targetUid, 42, 'a targeted event carries its target');
reset();
await publishEvent(5, { id: 2, type: 'chat' });
assert.equal(globalThis.__doOps[0].targetUid, null, 'and a public one explicitly carries none');

// publishState takes the state WHOLE — the per-uid fan-out (and the member list
// it needed) went with Ably; the object applies stateView per socket instead.
reset();
await publishState(5, { v: 9, game: { type: 'chess' }, secret: 'x' });
assert.equal(globalThis.__doOps[0].state.v, 9, 'the whole state blob goes over');
assert.equal(publishState.length, 2, 'and the signature no longer takes memberUids');

// --- an explicit id list gates per room, not globally ------------------------
process.env.DO_ROOMS = '5,9';
reset();
await publishState(5, { v: 1 });
await publishState(6, { v: 1 });
assert.deepEqual(globalThis.__doOps.map((o) => o.roomId), [5], 'only the listed room is pushed at');

delete process.env.DO_ROOMS;
console.log('dispatch-check: all assertions passed (four names, one seam, flag-gated)');

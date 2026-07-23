// Runnable check for the realtime helpers (pure shapes + graceful no-op).
// Run: node src/lib/server/realtime-check.js
import assert from 'node:assert';
import { register } from 'node:module';
register('./thief-env-stub-loader.mjs', import.meta.url);
delete process.env.ABLY_API_KEY; // force "unconfigured" for this check
const { roomChannel, userChannel, tokenCapability, publishState, publishEvent, roomTokenRequest } =
	await import('./realtime.js');

// channel names
assert.equal(roomChannel(5), 'room:5');
assert.equal(userChannel(5, 42), 'room:5:u:42');

// capability grants the public room channel + only this user's private channel
assert.deepEqual(tokenCapability(5, 42), {
	'room:5': ['subscribe'],
	'room:5:u:42': ['subscribe']
});

// with no ABLY_API_KEY everything is a silent no-op / null
await assert.doesNotReject(publishState(5, { v: 3, game: null }, [42, 43]), 'publishState never throws when off');
assert.equal(await publishState(5, { v: 3, game: null }, [42]), undefined);
await assert.doesNotReject(publishEvent(5, { id: 1, type: 'chat' }), 'publishEvent never throws when off');
assert.equal(await publishEvent(5, { id: 1, type: 'chat' }, 42), undefined);
assert.equal(await roomTokenRequest(5, 42), null, 'no token when disabled');

console.log('realtime-check: all assertions passed');

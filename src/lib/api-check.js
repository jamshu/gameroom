// Checks how api() reports a request that never reached the server. Players were
// seeing the browser's raw wording ("Load failed" on Safari, "Failed to fetch" on
// Chrome) when a move was posted over a flaky connection.
// Run: npm run check:api
import assert from 'node:assert';
import { register } from 'node:module';
register('./api-stub-loader.mjs', import.meta.url);
const { api } = await import('./api.js');

/** Swap in a fetch for one call. */
function withFetch(fn) {
	globalThis.fetch = fn;
}

const res = (status, body) => ({
	status,
	ok: status >= 200 && status < 300,
	json: async () => body
});

// 1. A dropped connection is reported in words a player can act on, and never in
//    the browser's own wording — that string is the whole complaint.
{
	withFetch(async () => {
		throw new TypeError('Load failed');
	});
	const e = await api('/api/rooms/1/carroms/shot', { method: 'POST', body: {} }).then(
		() => null,
		(err) => err
	);
	assert(e, 'a failed fetch must reject');
	assert(!/Load failed|Failed to fetch/i.test(e.message), `raw browser wording leaked: ${e.message}`);
	assert(/connection/i.test(e.message), `message should name the cause, got: ${e.message}`);
}

// 2. It is flagged, because that's what tells the caller to re-poll instead of
//    resending — resending a shot that did land would score it twice.
{
	withFetch(async () => {
		throw new TypeError('Failed to fetch');
	});
	const e = await api('/api/rooms/1/poll').catch((err) => err);
	assert(e.offline === true, 'a transport failure must set .offline');
	assert(e.status === undefined, 'no response means no status');
}

// 3. A server that DID answer is not mistaken for a dropped connection. This is
//    the distinction the flag exists to make: 500 is worth resending, offline is
//    not, and conflating them is how a double-applied move happens.
{
	withFetch(async () => res(500, { error: 'boom' }));
	const e = await api('/api/rooms/1/poll').catch((err) => err);
	assert(!e.offline, 'an HTTP error is not an offline error');
	assert(e.status === 500, `status should carry through, got ${e.status}`);
	assert(e.message === 'boom', `server message should win, got ${e.message}`);
}

// 4. The happy path still returns the parsed body.
{
	withFetch(async () => res(200, { ok: true, state: { v: 7 } }));
	const d = await api('/api/rooms/1/poll');
	assert(d.state.v === 7, 'a good response should come back parsed');
}

console.log('api: all checks passed');

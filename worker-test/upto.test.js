// I2 — the `upto` watermark, asserted against the running object.
//
//   The object must never send a frame with upto = N on a socket unless every
//   event with seq <= N that this socket is entitled to has already been sent on
//   that same socket, in order.
//
// It is not automatic, and breaking it is silent. Targeted events (WebRTC
// signals) are filtered per socket, so every client's view of the sequence has
// holes BY DESIGN and cannot tell "filtered out" from "not yet sent". A frame
// that over-claims makes the client advance its cursor past an event it never
// received; `?since=` only moves forward, so the event is gone for good. The
// symptom is voice stuck in `connecting` and a forced rejoin — which looks
// nothing like a watermark bug.
//
// check:frames asserts this on the frame BUILDERS. Only here can it be asserted
// on what the object actually puts on a socket, in order, while other writes are
// landing.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { kvSet, appendEvent, headSeq } from '../src/lib/do/schema.js';

function room(name) {
	return env.ROOM.get(env.ROOM.idFromName(name));
}

async function seedOwned(stub) {
	await runInDurableObject(stub, (instance) => {
		kvSet(instance.sql, 'hydrated_at', Date.now());
		// owns_state short-circuits ensureOwned, so `append` never reaches Odoo.
		kvSet(instance.sql, 'owns_state', 1);
		kvSet(instance.sql, 'room_id', 42);
		kvSet(instance.sql, 'room', { id: 42, name: 'test' });
		kvSet(instance.sql, 'members', [{ uid: 7 }, { uid: 20 }]);
		kvSet(instance.sql, 'members_raw', []);
		kvSet(instance.sql, 'state', { v: 1, voice: [], game: null });
	});
}

async function connect(stub, uid) {
	const res = await stub.fetch('https://do/api/rooms/42/ws', {
		headers: { upgrade: 'websocket', 'x-uid': String(uid), 'x-name': `U${uid}`, 'x-room-id': '42' }
	});
	const ws = res.webSocket;
	ws.accept();
	const frames = [];
	ws.addEventListener('message', (e) => {
		if (e.data === 'o') return;
		try { frames.push(JSON.parse(e.data)); } catch { /* ignore */ }
	});
	return { ws, frames };
}

const apply = (stub, op) =>
	stub.fetch('https://do/apply', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-room-id': '42' },
		body: JSON.stringify(op)
	}).then((r) => r.json());

/**
 * THE INVARIANT, as a function over one socket's frames in arrival order.
 *
 * Walks the stream tracking the highest event id this socket has actually been
 * given, and fails the moment any frame claims a watermark above it.
 */
function assertUptoNeverOverclaims(frames) {
	let delivered = 0;
	for (const f of frames) {
		for (const ev of f.events ?? []) delivered = Math.max(delivered, ev.id);
		if (f.event) delivered = Math.max(delivered, f.event.id);
		if (f.upto != null) {
			expect(
				f.upto,
				`frame ${f.t} claimed upto=${f.upto} but this socket has only received up to ${delivered}`
			).toBeLessThanOrEqual(delivered);
		}
	}
	return delivered;
}

describe('the upto watermark', () => {
	it('welcome stamps the max seq IN THE REPLAY, never the log head', async () => {
		const stub = room('welcome-upto');
		await seedOwned(stub);
		await runInDurableObject(stub, (instance) => {
			appendEvent(instance.sql, { type: 'chat', sender: 7, payload: { text: 'a' } });
			appendEvent(instance.sql, { type: 'chat', sender: 7, payload: { text: 'b' } });
			// A signal for uid 20 ONLY, and it is the newest thing in the log.
			appendEvent(instance.sql, { type: 'signal', sender: 7, target: 20, payload: { kind: 'offer' } });
		});

		const a = await connect(stub, 7);
		a.ws.send(JSON.stringify({ t: 'hello', cursor: 0, gv: 0, v: 1 }));
		await new Promise((r) => setTimeout(r, 50));

		const welcome = a.frames.find((f) => f.t === 'welcome');
		expect(welcome).toBeTruthy();
		const head = await runInDurableObject(stub, (instance) => headSeq(instance.sql));

		// The head is uid 20's signal. Stamping it here would march uid 7's cursor
		// past an event it is not entitled to and will never be sent.
		expect(head).toBe(3);
		expect(welcome.upto).toBe(2);
		expect(welcome.upto).toBeLessThan(head);
		assertUptoNeverOverclaims(a.frames);
	});

	it('holds while appends land during a joiner s replay', async () => {
		const stub = room('interleave');
		await seedOwned(stub);
		await runInDurableObject(stub, (instance) => {
			for (let i = 0; i < 5; i++) {
				appendEvent(instance.sql, { type: 'chat', sender: 7, payload: { n: i } });
			}
		});

		const a = await connect(stub, 7);
		const b = await connect(stub, 20);

		// Fire the replay and a burst of writes together, without awaiting between
		// them — this is the window an `await` inside the append path would open.
		a.ws.send(JSON.stringify({ t: 'hello', cursor: 0, gv: 0, v: 1 }));
		await Promise.all([
			apply(stub, { op: 'append', event: { type: 'chat', senderUid: 20, payload: { x: 1 } } }),
			apply(stub, { op: 'append', event: { type: 'signal', senderUid: 7, payload: { kind: 'ice' } }, targetUid: 20 }),
			apply(stub, { op: 'append', event: { type: 'chat', senderUid: 20, payload: { x: 2 } } }),
			apply(stub, { op: 'state', state: { v: 2, voice: [7], game: null } })
		]);
		await new Promise((r) => setTimeout(r, 50));

		// Neither socket may ever have been told it holds more than it was given.
		assertUptoNeverOverclaims(a.frames);
		assertUptoNeverOverclaims(b.frames);

		// And the filtering really happened, or the assertion above is vacuous.
		const aGotSignal = a.frames.some((f) => f.event?.type === 'signal');
		const bGotSignal = b.frames.some((f) => f.event?.type === 'signal');
		expect(aGotSignal).toBe(false);
		expect(bGotSignal).toBe(true);
	});

	it('a state frame carries no watermark, however many events preceded it', async () => {
		// The regression that lost WebRTC signals: a state push goes to EVERY socket
		// but delivers no events, so it cannot vouch for any of them.
		const stub = room('state-no-upto');
		await seedOwned(stub);
		const a = await connect(stub, 7);

		await apply(stub, { op: 'append', event: { type: 'signal', senderUid: 7, payload: {} }, targetUid: 20 });
		await apply(stub, { op: 'state', state: { v: 3, voice: [], game: null } });
		await new Promise((r) => setTimeout(r, 50));

		const state = a.frames.find((f) => f.t === 'state');
		expect(state).toBeTruthy();
		expect('upto' in state).toBe(false);
		assertUptoNeverOverclaims(a.frames);
	});

	it('an event frame vouches for exactly its own id', async () => {
		const stub = room('event-upto');
		await seedOwned(stub);
		const a = await connect(stub, 7);

		const res = await apply(stub, { op: 'append', event: { type: 'chat', senderUid: 20, payload: { text: 'hi' } } });
		await new Promise((r) => setTimeout(r, 50));

		const frame = a.frames.find((f) => f.t === 'event');
		expect(frame.event.id).toBe(res.id);
		expect(frame.upto).toBe(res.id);
		// The id must be the log's, not whatever the caller passed — the null-key
		// bug that shipped and duplicated chat keys. See frames.js withSeq.
		expect(frame.event.id).toBeGreaterThan(0);
	});
});

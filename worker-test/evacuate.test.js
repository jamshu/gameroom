// The M2.4 rollback, in the runtime.
//
// evacuate() has one promise that matters: IT MUST NOT COMPLETE UNTIL ITS FLUSH
// SUCCEEDS. Once `evacuated` is set the object refuses every op and the routes
// fall back to Odoo, so anything still only in this object's storage is gone —
// that is the difference between a rollback and a data-loss button.
//
// Odoo is unreachable in this harness (ODOO_URL points at a host that does not
// resolve), which is not an obstacle here — it is the whole reason the failure
// path can be tested at all. A flush that cannot reach Odoo is exactly the
// condition under which evacuating would lose data. The failing-flush test
// therefore logs a DNS error and a couple of retry waits; that noise IS the test
// working.
//
// Driven through /apply rather than by calling evacuate() directly, because that
// is the only way production reaches it — and because the interception has to
// happen ahead of the synchronous apply() switch, which is itself part of what is
// under test here.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { kvGet, kvSet, appendEvent } from '../src/lib/do/schema.js';

function room(name) {
	return env.ROOM.get(env.ROOM.idFromName(name));
}

async function seed(stub, { dirty }) {
	await runInDurableObject(stub, (instance) => {
		kvSet(instance.sql, 'hydrated_at', Date.now());
		kvSet(instance.sql, 'owns_state', 1);
		kvSet(instance.sql, 'room_id', 42);
		kvSet(instance.sql, 'room', { id: 42, name: 'test' });
		kvSet(instance.sql, 'members', []);
		kvSet(instance.sql, 'members_raw', []);
		kvSet(instance.sql, 'state', { v: 4, voice: [], game: null });
		kvSet(instance.sql, 'state_dirty_at', dirty ? Date.now() : 0);
	});
}

const apply = (stub, op) =>
	stub.fetch('https://do/apply', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-room-id': '42' },
		body: JSON.stringify(op)
	}).then((r) => r.json());

describe('evacuate', () => {
	it('REFUSES when the flush cannot reach Odoo, and stays owned', async () => {
		const stub = room('evac-refuses');
		await seed(stub, { dirty: true });
		// Something only this object holds.
		await runInDurableObject(stub, (instance) => {
			appendEvent(instance.sql, { type: 'chat', sender: 7, payload: { text: 'unflushed' } });
		});

		const res = await apply(stub, { op: 'evacuate' });
		expect(res.ok).toBe(false);

		await runInDurableObject(stub, (instance) => {
			// The room must still be on the object and still playable. Marking it
			// evacuated here would strand the write above with nothing to retry it.
			expect(kvGet(instance.sql, 'evacuated')).toBe(null);
			expect(kvGet(instance.sql, 'owns_state')).toBe(1);
			expect(kvGet(instance.sql, 'state_dirty_at')).toBeTruthy();
		});

		// And it still accepts writes, because it never handed the room back.
		const ack = await apply(stub, { op: 'state', state: { v: 5, voice: [], game: null } });
		expect(ack.ok).toBe(true);
	});

	it('completes on a clean drain, closes sockets 4002, and rejects later ops', async () => {
		const stub = room('evac-succeeds');
		await seed(stub, { dirty: false });

		const up = await stub.fetch('https://do/api/rooms/42/ws', {
			headers: { upgrade: 'websocket', 'x-uid': '7', 'x-name': 'Seven', 'x-room-id': '42' }
		});
		const ws = up.webSocket;
		ws.accept();
		const closed = new Promise((r) => ws.addEventListener('close', (e) => r(e.code)));

		const res = await apply(stub, { op: 'evacuate' });
		expect(res.ok).toBe(true);

		// 4002 is "the object handed the room back" — the client falls through to
		// HTTP and stops retrying rather than fighting the evacuation.
		expect(await closed).toBe(4002);

		await runInDurableObject(stub, (instance) => {
			expect(kvGet(instance.sql, 'evacuated')).toBe(1);
			expect(kvGet(instance.sql, 'owns_state')).toBe(0);
		});

		// Every op now refuses, and refuses with the exact string the dispatcher
		// matches on to fall back to Odoo (server/dostub.js isEvacuated).
		const ack = await apply(stub, { op: 'state', state: { v: 9 } });
		expect(ack).toEqual({ ok: false, error: 'evacuated' });

		// A socket must not be able to re-establish and resurrect a second writer.
		const again = await stub.fetch('https://do/api/rooms/42/ws', {
			headers: { upgrade: 'websocket', 'x-uid': '7', 'x-name': 'Seven', 'x-room-id': '42' }
		});
		expect(again.status).toBe(409);
	});

	it('is idempotent — a second call is a no-op, not a second flush', async () => {
		const stub = room('evac-idempotent');
		await seed(stub, { dirty: false });

		expect((await apply(stub, { op: 'evacuate' })).ok).toBe(true);
		const second = await apply(stub, { op: 'evacuate' });
		expect(second).toEqual({ ok: true, already: true });
	});

	it('the owning ops do not try to take ownership of an evacuated room', async () => {
		// fetch() gates ensureOwned on `evacuated`. Without that, a straggling write
		// would reach Odoo for a fresh hydrate and re-arm the object as a writer for
		// a room the operator has deliberately taken off it.
		const stub = room('evac-no-retake');
		await seed(stub, { dirty: false });
		await apply(stub, { op: 'evacuate' });

		const ack = await apply(stub, { op: 'append', event: { type: 'chat', senderUid: 7, payload: {} } });
		expect(ack).toEqual({ ok: false, error: 'evacuated' });
		await runInDurableObject(stub, (instance) => {
			expect(kvGet(instance.sql, 'owns_state')).toBe(0);
		});
	});
});

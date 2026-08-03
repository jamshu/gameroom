// Does ctx.storage.deleteAll() actually clear a SQLite-backed object?
//
// This decides whether destroy() is a fix or a new bug. If deleteAll only clears
// the KV namespace and leaves tables created through ctx.storage.sql, then a
// destroyed room keeps `hydrated_at` — and the next touch short-circuits
// ensureHydrated onto stale state for a room that no longer exists in Odoo.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { kvGet, kvSet, appendEvent, headSeq } from '../src/lib/do/schema.js';

describe('destroy', () => {
	it('deleteAll clears the SQL tables, not just the KV namespace', async () => {
		const stub = env.ROOM.get(env.ROOM.idFromName('destroy-wipes'));
		await runInDurableObject(stub, (instance) => {
			kvSet(instance.sql, 'hydrated_at', Date.now());
			kvSet(instance.sql, 'owns_state', 1);
			kvSet(instance.sql, 'room_id', 42);
			appendEvent(instance.sql, { type: 'chat', sender: 7, payload: { text: 'gone' } });
			expect(headSeq(instance.sql)).toBeGreaterThan(0);
		});

		const res = await stub.fetch('https://do/apply', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-room-id': '42' },
			body: JSON.stringify({ op: 'destroy' })
		}).then((r) => r.json());
		expect(res.ok).toBe(true);

		await runInDurableObject(stub, (instance) => {
			// If either of these survives, destroy() leaves a room that looks
			// hydrated and owned but whose Odoo rows are gone.
			expect(kvGet(instance.sql, 'hydrated_at')).toBe(null);
			expect(kvGet(instance.sql, 'owns_state')).toBe(null);
			expect(headSeq(instance.sql)).toBe(0);
		});
	});

	it('leaves a VALID empty object, not one with no schema', async () => {
		// deleteAll drops the tables. Without the re-migrate in destroy(), the very
		// next kvGet on this instance throws "no such table: kv" — the object is
		// bricked until it happens to be evicted, and anything that touches it in
		// between (a straggling op, an alarm) fails with a SQLITE_ERROR that says
		// nothing about what actually happened.
		const stub = env.ROOM.get(env.ROOM.idFromName('destroy-remigrates'));
		await runInDurableObject(stub, (instance) => {
			kvSet(instance.sql, 'hydrated_at', Date.now());
		});
		await runInDurableObject(stub, (instance) => instance.destroy());

		await runInDurableObject(stub, (instance) => {
			// Reads and writes both work again, against empty tables.
			expect(() => kvGet(instance.sql, 'anything')).not.toThrow();
			kvSet(instance.sql, 'room_id', 99);
			expect(kvGet(instance.sql, 'room_id')).toBe(99);
			expect(appendEvent(instance.sql, { type: 'chat', sender: 1, payload: {} })).toBe(1);
		});
	});

	it('cancels the pending alarm, so nothing fires into a deleted room', async () => {
		// The failure this prevents: an archive alarm survives destroy, fires
		// minutes later, tries to write a room Odoo no longer has, throws, and
		// flush() re-arms on failure — one doomed Odoo call every 15s forever, per
		// dead room, against a budget the whole app shares.
		const stub = env.ROOM.get(env.ROOM.idFromName('destroy-cancels-alarm'));
		await runInDurableObject(stub, async (instance, state) => {
			kvSet(instance.sql, 'hydrated_at', Date.now());
			await state.storage.setAlarm(Date.now() + 60_000);
			expect(await state.storage.getAlarm()).not.toBe(null);
		});

		await runInDurableObject(stub, (instance) => instance.destroy());

		await runInDurableObject(stub, async (instance, state) => {
			expect(await state.storage.getAlarm()).toBe(null);
		});
	});
});

// ---------------------------------------------------------------------------
// ORPHAN SELF-HEAL. deleteRoom sends `destroy`, but that only covers deletes
// that REACH the object. A transient failure there — or any room deleted before
// that wiring existed — strands an object that can never drain: every archive
// write targets rows Odoo no longer has, fails, and re-arms. It never
// hibernates and spends the shared Odoo budget forever.
//
// This was measured, not theorised: six orphans accumulated from six probe runs
// inside an hour, each retrying every 15 seconds.
describe('a flush that can never succeed', () => {
	it('backs off instead of retrying every 15s', async () => {
		const stub = env.ROOM.get(env.ROOM.idFromName('orphan-backoff'));
		await runInDurableObject(stub, (instance) => {
			kvSet(instance.sql, 'hydrated_at', Date.now());
			kvSet(instance.sql, 'room_id', 42);
			// The interval is a pure function of the failure count, so it can be
			// asserted without waiting out real alarms.
			kvSet(instance.sql, 'flush_fails', 0);
			expect(instance.archiveBackoffMs()).toBe(15_000);
			kvSet(instance.sql, 'flush_fails', 3);
			expect(instance.archiveBackoffMs()).toBe(120_000);
			kvSet(instance.sql, 'flush_fails', 99);
			expect(instance.archiveBackoffMs()).toBe(600_000); // capped, not unbounded
		});
	});

	it('sets the next check deadline BEFORE awaiting, so a throwing check cannot loop', async () => {
		// The counter version of this shipped and did not work: production showed
		// flushFails pinned at 2 and the check never firing, because more than one
		// path reset it. A deadline only moves forward, so nothing can hold it back
		// — and it must be written before the await, or a check that throws would
		// leave the deadline in the past and re-ask on every single alarm.
		const stub = env.ROOM.get(env.ROOM.idFromName('orphan-deadline'));
		await runInDurableObject(stub, (instance) => {
			kvSet(instance.sql, 'hydrated_at', Date.now());
			kvSet(instance.sql, 'owns_state', 1);
			kvSet(instance.sql, 'room_id', 42);
			kvSet(instance.sql, 'state_dirty_at', Date.now());
			appendEvent(instance.sql, { type: 'chat', sender: 7, payload: {} });
			expect(kvGet(instance.sql, 'next_orphan_check_at', 0)).toBe(0);
		});

		await runInDurableObject(stub, (instance) => instance.flush());

		await runInDurableObject(stub, (instance) => {
			// Odoo is unreachable here, so roomExists threw — and the deadline must
			// still have advanced.
			const due = Number(kvGet(instance.sql, 'next_orphan_check_at', 0));
			expect(due).toBeGreaterThan(Date.now());
		});
	});

	it('does NOT self-destruct when Odoo is merely unreachable', async () => {
		// The distinction that matters. The orphan check asks "is the room gone?";
		// if that question itself cannot be answered, the answer is not "yes".
		// Odoo is unreachable in this harness, so roomExists throws — and the object
		// must survive, because destroying it here would discard unflushed state
		// during an ordinary outage.
		const stub = env.ROOM.get(env.ROOM.idFromName('orphan-outage'));
		await runInDurableObject(stub, (instance) => {
			kvSet(instance.sql, 'hydrated_at', Date.now());
			kvSet(instance.sql, 'owns_state', 1);
			kvSet(instance.sql, 'room_id', 42);
			kvSet(instance.sql, 'state', { v: 3, voice: [], game: null });
			kvSet(instance.sql, 'state_dirty_at', Date.now());
			kvSet(instance.sql, 'next_orphan_check_at', 0); // the check is due
			appendEvent(instance.sql, { type: 'chat', sender: 7, payload: { text: 'unflushed' } });
		});

		await runInDurableObject(stub, (instance) => instance.flush());

		await runInDurableObject(stub, (instance) => {
			// Storage intact, still dirty, still owed — the retry has something to do.
			expect(kvGet(instance.sql, 'hydrated_at')).toBeTruthy();
			expect(kvGet(instance.sql, 'state_dirty_at')).toBeTruthy();
			expect(headSeq(instance.sql)).toBeGreaterThan(0);
			expect(kvGet(instance.sql, 'flush_fails')).toBeGreaterThan(0);
		});
	});
});

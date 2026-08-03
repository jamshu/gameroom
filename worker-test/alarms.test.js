// Alarm chaining — the cost story, which is not observable anywhere else.
//
// The object multiplexes every timed job onto ONE alarm, storing each job's due
// time in kv and re-arming for the earliest. The load-bearing case is the last
// one: when the final socket closes, the idle job flushes and then schedules
// NOTHING. No timer plus no sockets is what lets workerd hibernate the object and
// stop billing duration. A "just in case" periodic alarm would quietly make every
// idle room cost money forever, and nothing in the app would look wrong.
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { kvGet, kvSet } from '../src/lib/do/schema.js';

/** A stub for a fresh object, pre-hydrated so nothing reaches Odoo. */
function freshRoom(name) {
	const id = env.ROOM.idFromName(name);
	return env.ROOM.get(id);
}

/** Mark the object as already loaded, so ensureHydrated short-circuits. */
async function seedHydrated(stub, roomId = 42) {
	await runInDurableObject(stub, (instance) => {
		kvSet(instance.sql, 'hydrated_at', Date.now());
		kvSet(instance.sql, 'room_id', roomId);
		kvSet(instance.sql, 'room', { id: roomId, name: 'test' });
		kvSet(instance.sql, 'members', []);
		kvSet(instance.sql, 'members_raw', []);
	});
}

describe('the idle alarm', () => {
	it('schedules nothing afterwards, so an idle room can hibernate', async () => {
		const stub = freshRoom('idle-goes-quiet');
		await seedHydrated(stub);

		await runInDurableObject(stub, async (instance, state) => {
			// No sockets, nothing owed to Odoo, and the wind-down is due.
			kvSet(instance.sql, 'state_dirty_at', 0);
			kvSet(instance.sql, 'next_idle_at', Date.now() - 1);
			// Scheduled in the FUTURE on purpose. runDurableObjectAlarm() invokes the
			// handler immediately whatever its due time, whereas an alarm set in the
			// past can be delivered by the runtime first — leaving nothing scheduled
			// and making this read as "the alarm never ran". The job's own due time in
			// kv above is what makes the idle branch the one that fires.
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);

		await runInDurableObject(stub, async (instance, state) => {
			expect(await state.storage.getAlarm()).toBe(null);
			expect(instance.ctx.getWebSockets().length).toBe(0);
		});
	});

	it('but a dirty room DOES re-arm, or the write-behind would strand', async () => {
		// THE CONTRAST HAS TO GO THROUGH alarm(), or the pair is vacuous: an alarm()
		// body of `{ return; }` satisfies the test above on both counts — it "ran",
		// and it left nothing scheduled. Only re-arming from inside the handler
		// distinguishes "deliberately went quiet" from "does nothing at all".
		const stub = freshRoom('dirty-rearms');
		await seedHydrated(stub);

		await runInDurableObject(stub, async (instance, state) => {
			// Something is owed to Odoo and no socket is open — the same shape as the
			// idle test, differing only in being dirty. Odoo is unreachable here, so
			// the flush fails, which is precisely the case that must re-arm rather
			// than strand the write.
			kvSet(instance.sql, 'state_dirty_at', Date.now());
			kvSet(instance.sql, 'owns_state', 1);
			kvSet(instance.sql, 'state', { v: 2, voice: [], game: null });
			kvSet(instance.sql, 'next_archive_at', Date.now() - 1);
			kvSet(instance.sql, 'next_idle_at', 0);
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);

		await runInDurableObject(stub, async (instance, state) => {
			expect(await state.storage.getAlarm()).not.toBe(null);
			// And it is still owed, so the retry has something to do.
			expect(kvGet(instance.sql, 'state_dirty_at')).toBeTruthy();
		});
	});

	it('does not push out an alarm that is already pending', async () => {
		// ensureDue exists so a burst of writes cannot keep deferring the flush:
		// each markDirty() would otherwise reset the archive to now+15s and a room
		// under continuous play would never persist at all.
		const stub = freshRoom('no-deferral');
		await seedHydrated(stub);

		await runInDurableObject(stub, (instance) => {
			const first = instance.ensureDue('next_archive_at', Date.now() + 15_000);
			const second = instance.ensureDue('next_archive_at', Date.now() + 15_000);
			expect(second).toBe(first);
			expect(kvGet(instance.sql, 'next_archive_at')).toBe(first);
		});
	});
});

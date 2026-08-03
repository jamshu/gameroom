// The voice roster is owned by the OBJECT, not carried in the state blob.
//
// The bug this suite pins down: every route does a read-modify-write of the whole
// state blob (parseState at the top of the request, setState at the bottom), and
// `voice` rode along inside it. Anything that changed the roster between those two
// points was erased by a write that had nothing to do with voice — and erased
// SILENTLY, because the clobbering write lands at a higher version and therefore
// looks like the newest truth to every client.
//
// The window is widest exactly where the reports came from: `end`, `rematch` and
// `game-type` all run Odoo writes (resetRound, reseatRoles) between their read and
// their write, and they run in the lobby, which is where people press Join voice.
//
// Only reachable here. The check:* scripts run pure logic under node, and no
// Playwright spec sets `do` — they all take the Odoo path, where this race does
// not exist.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { kvGet, kvSet } from '../src/lib/do/schema.js';
import { VOICE_CAP } from '../src/lib/shared/gamelogic.js';

const room = (n) => env.ROOM.get(env.ROOM.idFromName(n));

const GAME = { type: 'chess', fen: 'start', moves: [] };

async function seedOwned(stub, { voice = [], game = null } = {}) {
	await runInDurableObject(stub, (instance) => {
		kvSet(instance.sql, 'hydrated_at', Date.now());
		// owns_state short-circuits ensureOwned, so no op reaches odoo.invalid.
		kvSet(instance.sql, 'owns_state', 1);
		kvSet(instance.sql, 'room_id', 42);
		kvSet(instance.sql, 'room', { id: 42, name: 'test' });
		kvSet(instance.sql, 'members', [{ uid: 7 }, { uid: 20 }]);
		kvSet(instance.sql, 'members_raw', []);
		kvSet(instance.sql, 'state', {
			v: 1,
			voice,
			voiceSince: voice.length >= 2 ? Date.now() : null,
			game
		});
	});
}

async function connect(stub, uid) {
	const res = await stub.fetch('https://do/api/rooms/42/ws', {
		headers: { upgrade: 'websocket', 'x-uid': String(uid), 'x-name': `U${uid}`, 'x-room-id': '42' }
	});
	const ws = res.webSocket;
	ws.accept();
	return ws;
}

const apply = (stub, op) =>
	stub.fetch('https://do/apply', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-room-id': '42' },
		body: JSON.stringify(op)
	}).then((r) => r.json());

const stateOf = (stub) => runInDurableObject(stub, (instance) => kvGet(instance.sql, 'state'));

describe('the object owns the voice roster', () => {
	it('an unrelated setState cannot clobber a join that landed inside its window', async () => {
		// THE REPORTED BUG. The host's End Game read the blob before B pressed Join
		// voice and wrote it back after — so B was added and then silently deleted,
		// with no error anywhere and no way for B's client to notice.
		const stub = room('voice-clobber');
		await seedOwned(stub, { game: GAME });

		// A route reads the blob...
		const stale = await stateOf(stub);
		expect(stale.voice).toEqual([]);

		// ...B joins voice while that route is still awaiting Odoo...
		const joined = await apply(stub, { op: 'voice', action: 'join', uid: 7 });
		expect(joined.ok).toBe(true);
		expect(joined.state.voice).toEqual([7]);

		// ...and the route writes its now-stale copy back.
		const res = await apply(stub, {
			op: 'setState',
			state: { ...stale, game: null } // resetRound's blob: game dropped, voice as read
		});
		expect(res.ok).toBe(true);

		const after = await stateOf(stub);
		expect(after.voice).toEqual([7]); // survived
		expect(after.game).toBe(null); // and the route's own change still applied
	});

	it('keeps voiceSince across an unrelated write, so the call timer does not reset', async () => {
		const stub = room('voice-since-survives');
		await seedOwned(stub, { voice: [7, 20] });
		const since = (await stateOf(stub)).voiceSince;
		expect(since).toBeTruthy();

		await apply(stub, { op: 'setState', state: { v: 1, voice: [], voiceSince: null, game: GAME } });

		const after = await stateOf(stub);
		expect(after.voice).toEqual([7, 20]);
		expect(after.voiceSince).toBe(since);
		expect(after.game).toEqual(GAME);
	});

	it('does not resurrect someone the object dropped when their socket closed', async () => {
		// The same clobber running the other way: it puts ghosts BACK on the roster,
		// which is how a room reaches VOICE_CAP with nobody actually in the call.
		const stub = room('voice-no-ghosts');
		await seedOwned(stub, { voice: [7, 20] });
		const a = await connect(stub, 7);
		await connect(stub, 20);

		a.close(1000, 'gone');
		await new Promise((r) => setTimeout(r, 100)); // webSocketClose is async

		expect((await stateOf(stub)).voice).toEqual([20]);

		// A route that read the blob before the close now writes it back.
		await apply(stub, { op: 'setState', state: { v: 1, voice: [7, 20], game: null } });

		expect((await stateOf(stub)).voice).toEqual([20]);
	});

	it('a voice op touches the roster and nothing else', async () => {
		const stub = room('voice-op-scope');
		await seedOwned(stub, { game: GAME });

		const res = await apply(stub, { op: 'voice', action: 'join', uid: 7 });

		expect(res.ok).toBe(true);
		const after = await stateOf(stub);
		expect(after.voice).toEqual([7]);
		expect(after.game).toEqual(GAME); // the game blob is not this op's business
		expect(after.v).toBe(2); // exactly one bump
		// and it is owed to Odoo, same as any other authoritative write
		const dirty = await runInDurableObject(stub, (i) => kvGet(i.sql, 'state_dirty_at'));
		expect(dirty).toBeTruthy();
	});

	it('starts the call clock at two and stops it below two', async () => {
		const stub = room('voice-clock');
		await seedOwned(stub);

		await apply(stub, { op: 'voice', action: 'join', uid: 7 });
		expect((await stateOf(stub)).voiceSince).toBe(null); // one person is waiting

		await apply(stub, { op: 'voice', action: 'join', uid: 20 });
		expect((await stateOf(stub)).voiceSince).toBeTruthy();

		await apply(stub, { op: 'voice', action: 'leave', uid: 20 });
		const after = await stateOf(stub);
		expect(after.voice).toEqual([7]);
		expect(after.voiceSince).toBe(null);
	});

	it('is idempotent in both directions, without a needless version bump', async () => {
		const stub = room('voice-idempotent');
		await seedOwned(stub, { voice: [7] });

		await apply(stub, { op: 'voice', action: 'join', uid: 7 }); // already in
		await apply(stub, { op: 'voice', action: 'leave', uid: 20 }); // never was

		const after = await stateOf(stub);
		expect(after.voice).toEqual([7]);
		expect(after.v).toBe(1);
	});

	it('refuses a join past the cap, in the object rather than after a read', async () => {
		// The HTTP route checked the cap against a blob it had already read, so two
		// simultaneous joins could both pass it. Inside the object there is no window.
		const stub = room('voice-cap');
		await seedOwned(stub, { voice: Array.from({ length: VOICE_CAP }, (_, i) => 100 + i) });

		const res = await apply(stub, { op: 'voice', action: 'join', uid: 7 });

		expect(res.ok).toBe(false);
		expect(res.status).toBe(409);
		expect(res.code).toBe('voice_full');
		expect((await stateOf(stub)).voice).not.toContain(7);
	});
});

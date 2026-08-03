// M2.6 — presence and voice derived from live sockets.
//
// Both behaviours here exist only in the runtime: they are triggered by a socket
// CLOSING, which no pure check and no mocked browser test can produce.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { kvGet, kvSet } from '../src/lib/do/schema.js';
import { publicMembers, PRESENCE_WINDOW_MS } from '../src/lib/shared/roomview.js';

const room = (n) => env.ROOM.get(env.ROOM.idFromName(n));
const odooTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

async function seed(stub, { voice = [] } = {}) {
	// Members shaped exactly as the routes ship them: publicMembers output, with
	// last_seen long stale so any `online:true` below must come from a socket.
	const rows = [7, 20].map((uid) => ({
		id: uid,
		x_studio_user_id: [uid, `U${uid}`],
		x_studio_status: 'accepted',
		x_studio_role: 'player',
		x_studio_score: 0,
		x_studio_last_seen: odooTime(Date.now() - PRESENCE_WINDOW_MS * 4)
	}));
	await runInDurableObject(stub, (instance) => {
		kvSet(instance.sql, 'hydrated_at', Date.now());
		kvSet(instance.sql, 'owns_state', 1);
		kvSet(instance.sql, 'room_id', 42);
		kvSet(instance.sql, 'room', { id: 42, name: 'test' });
		kvSet(instance.sql, 'members', publicMembers(rows));
		kvSet(instance.sql, 'state', { v: 1, voice, voiceSince: voice.length >= 2 ? Date.now() : null, game: null });
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

describe('presence', () => {
	it('a socket makes you online even when last_seen is ancient', async () => {
		const stub = room('presence-socket-wins');
		await seed(stub);
		await connect(stub, 7);

		await runInDurableObject(stub, (instance) => {
			const roster = instance.membersWithPresence();
			expect(roster.find((m) => m.uid === 7).online).toBe(true);
			expect(roster.find((m) => m.uid === 20).online).toBe(false);
		});
	});

	it('re-decides on every read instead of re-serving a frozen verdict', async () => {
		// The bug this replaces: `online` was computed once when the roster was
		// stored and handed back unchanged for the life of the room, so whoever was
		// online at that moment stayed online forever.
		const stub = room('presence-not-frozen');
		await seed(stub);
		await runInDurableObject(stub, (instance) => {
			// Store a roster that CLAIMS everyone is online, with stale timestamps.
			const stored = (kvGet(instance.sql, 'members', []) ?? []).map((m) => ({ ...m, online: true }));
			kvSet(instance.sql, 'members', stored);
			// No sockets, all timestamps stale -> everyone must read back offline.
			expect(instance.membersWithPresence().every((m) => m.online === false)).toBe(true);
		});
	});

	it('keeps an HTTP-fallback player online from last_seen alone', async () => {
		// Socket-only presence would render every player on the fallback offline —
		// including to themselves. The union is what prevents that.
		const stub = room('presence-fallback');
		await seed(stub);
		await runInDurableObject(stub, (instance) => {
			const fresh = (kvGet(instance.sql, 'members', []) ?? []).map((m) =>
				m.uid === 20 ? { ...m, lastSeen: Date.now() } : m
			);
			kvSet(instance.sql, 'members', fresh);
			expect(instance.membersWithPresence().find((m) => m.uid === 20).online).toBe(true);
		});
	});
});

describe('a closing socket ends the call', () => {
	it('drops the uid from voice and clears voiceSince below two', async () => {
		const stub = room('voice-on-close');
		await seed(stub, { voice: [7, 20] });
		const a = await connect(stub, 7);
		await connect(stub, 20);

		a.close(1000, 'gone');
		// webSocketClose is delivered asynchronously.
		await new Promise((r) => setTimeout(r, 100));

		await runInDurableObject(stub, (instance) => {
			const state = kvGet(instance.sql, 'state');
			expect(state.voice).toEqual([20]);
			// One person left in voice is waiting, not talking — the clock stops.
			expect(state.voiceSince).toBe(null);
			expect(state.v).toBeGreaterThan(1); // the change was published
			expect(kvGet(instance.sql, 'state_dirty_at')).toBeTruthy(); // and will persist
		});
	});

	it('does NOT hang up when the same player still has another tab', async () => {
		const stub = room('voice-two-tabs');
		await seed(stub, { voice: [7, 20] });
		const tab1 = await connect(stub, 7);
		await connect(stub, 7); // second tab, same uid
		await connect(stub, 20);

		tab1.close(1000, 'closed one tab');
		await new Promise((r) => setTimeout(r, 100));

		await runInDurableObject(stub, (instance) => {
			expect(kvGet(instance.sql, 'state').voice).toEqual([7, 20]);
		});
	});

	it('leaves voice alone for a player who was not in the call', async () => {
		const stub = room('voice-not-in-call');
		await seed(stub, { voice: [20] });
		const a = await connect(stub, 7);
		await connect(stub, 20);

		a.close(1000, 'gone');
		await new Promise((r) => setTimeout(r, 100));

		await runInDurableObject(stub, (instance) => {
			const state = kvGet(instance.sql, 'state');
			expect(state.voice).toEqual([20]);
			expect(state.v).toBe(1); // no needless version bump
		});
	});
});

// Hibernation survival.
//
// Hibernation evicts the object's MEMORY but keeps its storage, its WebSocket
// tags and each socket's serialized attachment. That is the whole reason this
// object holds no `Map` of sockets: a uid->socket registry in a field would be
// silently empty after the first eviction, and the symptom would be a room where
// nobody receives anything with no error anywhere.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. workerd does not expose a way to force
// eviction, so nothing here proves an object came back from one. What it does
// prove is the property that makes eviction survivable: every piece of routing
// state is read back out of ctx/storage rather than out of an instance field.
// A regression that reintroduced an in-memory registry would still pass a naive
// "does broadcast work" test and fail these.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { kvSet } from '../src/lib/do/schema.js';

function room(name) {
	return env.ROOM.get(env.ROOM.idFromName(name));
}

async function seedHydrated(stub, roomId = 42) {
	await runInDurableObject(stub, (instance) => {
		kvSet(instance.sql, 'hydrated_at', Date.now());
		kvSet(instance.sql, 'room_id', roomId);
		kvSet(instance.sql, 'room', { id: roomId, name: 'test' });
		kvSet(instance.sql, 'members', [{ uid: 7, name: 'Seven' }, { uid: 20, name: 'Twenty' }]);
		kvSet(instance.sql, 'members_raw', []);
	});
}

/** Open a real socket against the object, the way the worker wrapper does. */
async function connect(stub, uid, name = `U${uid}`) {
	const res = await stub.fetch('https://do/api/rooms/42/ws', {
		headers: { upgrade: 'websocket', 'x-uid': String(uid), 'x-name': name, 'x-room-id': '42' }
	});
	expect(res.status).toBe(101);
	const ws = res.webSocket;
	ws.accept();
	const frames = [];
	ws.addEventListener('message', (e) => {
		if (e.data === 'o') return;
		try { frames.push(JSON.parse(e.data)); } catch { /* ignore */ }
	});
	return { ws, frames };
}

describe('socket state lives in tags and attachments, not memory', () => {
	it('routes to one uid by tag, and handles the same player on two tabs', async () => {
		const stub = room('tag-routing');
		await seedHydrated(stub);
		await connect(stub, 7);
		await connect(stub, 7); // second tab, same uid
		await connect(stub, 20);

		await runInDurableObject(stub, (instance) => {
			// The tag is the routing table. Two tabs for uid 7 must both be found, or
			// a kick would close one and leave the other receiving the room.
			expect(instance.ctx.getWebSockets('u:7').length).toBe(2);
			expect(instance.ctx.getWebSockets('u:20').length).toBe(1);
			expect(instance.ctx.getWebSockets().length).toBe(3);
		});
	});

	it('round-trips {uid,name} through serializeAttachment', async () => {
		const stub = room('attachments');
		await seedHydrated(stub);
		await connect(stub, 7, 'Seven');

		await runInDurableObject(stub, (instance) => {
			const [ws] = instance.ctx.getWebSockets('u:7');
			const a = ws.deserializeAttachment();
			expect(a.uid).toBe(7);
			expect(a.name).toBe('Seven');
			expect(typeof a.openedAt).toBe('number');
		});
	});

	it('derives presence from live sockets, not from a stored roster', async () => {
		// This is what replaces the 90s last_seen staleness guess, and what lets
		// pruneStaleVoice be skipped for DO rooms.
		const stub = room('presence');
		await seedHydrated(stub);
		await connect(stub, 7);

		await runInDurableObject(stub, (instance) => {
			expect([...instance.liveUids()]).toEqual([7]);
			const roster = instance.membersWithPresence();
			expect(roster.find((m) => m.uid === 7).online).toBe(true);
			expect(roster.find((m) => m.uid === 20).online).toBe(false);
		});
	});

	it('kick closes every socket a uid holds, and only that uid s', async () => {
		const stub = room('kick');
		await seedHydrated(stub);
		const a = await connect(stub, 7);
		const b = await connect(stub, 7);
		const other = await connect(stub, 20);

		const closedA = new Promise((r) => a.ws.addEventListener('close', (e) => r(e.code)));
		const closedB = new Promise((r) => b.ws.addEventListener('close', (e) => r(e.code)));

		await runInDurableObject(stub, (instance) => instance.kick(7));

		// 4003 is terminal on the client — a removed player must stop reconnecting.
		expect(await closedA).toBe(4003);
		expect(await closedB).toBe(4003);

		await runInDurableObject(stub, (instance) => {
			expect(instance.ctx.getWebSockets('u:20').length).toBe(1);
		});
		expect(other.ws.readyState).not.toBe(3);
	});
});

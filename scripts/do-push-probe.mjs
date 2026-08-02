// M2.3 integration probe: does a write by one player reach another over the DO
// socket, without either of them polling?
//
//   npx wrangler dev --port 8793 --local --var DO_ROOMS:all
//   node scripts/do-push-probe.mjs http://127.0.0.1:8793
//
// Two real accounts, one real room, two real sockets. Asserts that a chat POST
// by A is delivered to B as an `event` frame, and that the `upto` watermark is
// the event's own id — the invariant the client's cursor rule depends on.
import WebSocket from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:8793';
const WSB = BASE.replace(/^http/, 'ws');
const j = (r) => r.json().catch(() => ({}));

function session() {
	const jar = [];
	return {
		keep: (res) => { for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0]); },
		cookie: () => jar.join('; ')
	};
}

async function signup(s, name) {
	const res = await fetch(`${BASE}/api/auth/signup`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name, login: `probe-${name}-${Date.now()}@example.com`, password: 'testpass123' })
	});
	s.keep(res);
	const d = await j(res);
	if (!d.ok) throw new Error(`signup ${name} failed: ${JSON.stringify(d)}`);
	return d.user;
}

async function del(s) {
	await fetch(`${BASE}/api/account/delete`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookie() },
		body: JSON.stringify({ confirm: 'DELETE' })
	}).catch(() => {});
}

function connect(s, roomId, label) {
	const ws = new WebSocket(`${WSB}/api/rooms/${roomId}/ws`, { headers: { cookie: s.cookie() } });
	const frames = [];
	ws.on('message', (d) => {
		const t = d.toString();
		if (t === 'o') return;
		try { frames.push(JSON.parse(t)); } catch { /* ignore */ }
	});
	ws.frames = frames;
	ws.label = label;
	ws.waitFor = (pred, what, ms = 10000) =>
		new Promise((resolve, reject) => {
			const hit = frames.find(pred);
			if (hit) return resolve(hit);
			const t = setTimeout(() => reject(new Error(`${label}: timeout waiting for ${what}`)), ms);
			const on = (d) => {
				const s2 = d.toString();
				if (s2 === 'o') return;
				let f; try { f = JSON.parse(s2); } catch { return; }
				if (pred(f)) { clearTimeout(t); ws.off('message', on); resolve(f); }
			};
			ws.on('message', on);
		});
	return new Promise((resolve, reject) => {
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
		setTimeout(() => reject(new Error(`${label}: socket never opened`)), 10000);
	});
}

const A = session(), B = session();
let wsA, wsB;
try {
	const ua = await signup(A, 'Alpha');
	const ub = await signup(B, 'Bravo');

	let res = await fetch(`${BASE}/api/rooms`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie() },
		body: JSON.stringify({ name: 'push probe', gameType: 'chess', maxPlayers: 2, drawsTotal: 0, visibility: 'public' })
	});
	const { roomId } = await j(res);
	console.log(`[1] room ${roomId}: A=${ua.uid} B=${ub.uid}`);

	// B joins and A approves, so both are accepted members.
	await fetch(`${BASE}/api/rooms/${roomId}/join`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: B.cookie() }, body: '{}' });
	// The host sees B's pending row; requests/ is keyed by MEMBER id, not uid.
	res = await fetch(`${BASE}/api/rooms/${roomId}`, { headers: { cookie: A.cookie() } });
	const pre = await j(res);
	const bRow = pre.members?.find((m) => m.uid === ub.uid);
	if (!bRow) throw new Error('B has no member row after join');
	res = await fetch(`${BASE}/api/rooms/${roomId}/requests`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie() },
		body: JSON.stringify({ memberId: bRow.id, action: 'accept' })
	});
	console.log(`[2] B accepted -> ${res.status}`);
	if (!res.ok) throw new Error('could not accept B: ' + JSON.stringify(await j(res)));

	// The flag must reach the client, or nothing else here matters.
	res = await fetch(`${BASE}/api/rooms/${roomId}`, { headers: { cookie: A.cookie() } });
	const detail = await j(res);
	console.log(`[3] room detail do=${detail.do}`);
	if (detail.do !== true) throw new Error('room detail must report do:true under DO_ROOMS=all');

	wsA = await connect(A, roomId, 'A');
	wsB = await connect(B, roomId, 'B');
	wsA.send(JSON.stringify({ t: 'hello', cursor: 0, gv: 0, v: 1 }));
	wsB.send(JSON.stringify({ t: 'hello', cursor: 0, gv: 0, v: 1 }));
	const wa = await wsA.waitFor((f) => f.t === 'welcome', 'A welcome');
	await wsB.waitFor((f) => f.t === 'welcome', 'B welcome');
	console.log(`[4] both welcomed; A sees room=${wa.room?.name ?? 'null'} members=${wa.members?.length ?? 0}`);
	// Hydration: the DO must have read the room out of Odoo before anyone could
	// observe it empty. An empty roster here is the bug that made a client render
	// as though the host had vanished.
	if (!wa.room) throw new Error('welcome carried no room — DO did not hydrate');
	if (!wa.members?.length) throw new Error('welcome carried an empty roster — DO did not hydrate');

	// The actual question: A writes over HTTP, B hears it on the socket.
	const heard = wsB.waitFor((f) => f.t === 'event' && f.event?.type === 'chat', 'B chat event');
	res = await fetch(`${BASE}/api/rooms/${roomId}/chat`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie() },
		body: JSON.stringify({ text: 'hello over the durable object' })
	});
	const posted = await j(res);
	const frame = await heard;
	console.log(`[5] B received chat id=${frame.event.id} upto=${frame.upto} text="${frame.event.payload?.text}"`);

	if (frame.event.payload?.text !== 'hello over the durable object') throw new Error('payload mismatch');
	if (frame.upto !== frame.event.id) throw new Error(`upto (${frame.upto}) must equal the event id (${frame.event.id})`);
	// Odoo's id space is preserved while both transports are live — a DO-minted id
	// starting at 1 would collide with chat the poll already keyed.
	if (frame.event.id < 100) throw new Error(`event id ${frame.event.id} looks DO-minted; Odoo's id must be carried through`);
	if (posted.id && posted.id !== frame.event.id) throw new Error(`POST id ${posted.id} != pushed id ${frame.event.id}`);

	// A roster change must also reach the socket.
	const roster = wsB.waitFor((f) => f.t === 'roster', 'B roster');
	res = await fetch(`${BASE}/api/rooms/${roomId}/roles`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie() },
		body: JSON.stringify({ memberId: bRow.id, role: 'spectator' })
	});
	if (!res.ok) throw new Error('roles failed: ' + JSON.stringify(await j(res)));
	const r = await roster;
	console.log(`[6] B received roster ts=${r.ts} members=${r.members?.length}`);

	// REGRESSION (voice): a state frame must not move the event cursor.
	// A targeted signal goes only to its recipient. If the state broadcast that
	// follows carried the log head as `upto`, every socket would advance past it —
	// and any socket that missed the signal frame would lose it permanently. The
	// poll's `?since=` never asks again, so the WebRTC offer/ICE is gone and the
	// peer sits in `connecting` until the watchdog forces a rejoin.
	const sawState = wsA.waitFor((f) => f.t === 'state', 'A state frame');
	res = await fetch(`${BASE}/api/rooms/${roomId}/voice`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie() },
		body: JSON.stringify({ action: 'join' })
	});
	if (!res.ok) throw new Error('voice join failed: ' + JSON.stringify(await j(res)));
	const sf = await sawState;
	console.log(`[7] A state frame keys=[${Object.keys(sf).join(',')}]`);
	if ('upto' in sf) throw new Error('state frame carries upto — the bug that loses WebRTC signals');

	console.log('\nPASS: push delivered, upto == event id, Odoo id space preserved, state frames carry no watermark.');
} finally {
	try { wsA?.close(); wsB?.close(); } catch { /* ignore */ }
	await del(A); await del(B);
	console.log('test accounts deleted');
}

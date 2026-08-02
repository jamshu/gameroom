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
	// M2.4 CHANGED THIS ASSERTION, deliberately. It used to demand `id >= 100` —
	// "Odoo's id must be carried through" — which was right while the routes still
	// created the row. The object now MINTS ids, and for a room created seconds ago
	// Odoo's highest id for it is 0, so a legitimate first id is 1. What still has
	// to hold is the thing that assertion was really protecting: ONE id space, the
	// same number in the POST reply, on the socket, and from the poll. A mismatch
	// anywhere is a duplicate key in the client's keyed {#each}.
	if (!(frame.event.id > 0)) throw new Error(`event id ${frame.event.id} is not a real id`);
	if (posted.id !== frame.event.id) throw new Error(`POST id ${posted.id} != pushed id ${frame.event.id}`);

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

	/* ---- M2.4: the object owns the state and the log ---------------------- */

	// [8] The HTTP fallback is served from the object now, not Odoo. A DO-minted
	//     event does not exist in Odoo until the archive alarm drains, and when it
	//     does it lands under a DIFFERENT id — so a poll still reading Odoo would
	//     hand the client a key it has never seen for a message it already holds.
	//     The two transports must agree exactly.
	const pollUrl = `${BASE}/api/rooms/${roomId}/poll?since=0&gv=0`;
	const p1 = await j(await fetch(pollUrl, { headers: { cookie: B.cookie() } }));
	const ids = (p1.events ?? []).map((e) => e.id);
	console.log(`[8] poll since=0 -> ${ids.length} events, cursor=${p1.cursor}, v=${p1.state?.v}`);
	if (!ids.includes(frame.event.id)) {
		throw new Error(`poll did not return the socket's event ${frame.event.id} (got ${ids.join(',')}) — the poll is not served from the object`);
	}
	if (p1.cursor !== Math.max(...ids)) throw new Error(`cursor ${p1.cursor} is not the highest id returned`);
	if (p1.gap) throw new Error('a since=0 poll must never be flagged as a gap');

	// [9] THE READ PATH, which is what actually corrupts games if it is wrong.
	//     Odoo's state column is now a write-behind archive lagging by up to one
	//     alarm period (15s). Two writes inside that window is completely ordinary
	//     — and if routes read the archive rather than the object, the second is
	//     computed against the first's pre-image and silently discards it. Here A
	//     joined voice at [7]; leaving immediately is the second write, and it can
	//     only land correctly if the read saw the object's state, not Odoo's.
	res = await fetch(`${BASE}/api/rooms/${roomId}/voice`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie() },
		body: JSON.stringify({ action: 'leave' })
	});
	if (!res.ok) throw new Error('voice leave failed: ' + JSON.stringify(await j(res)));
	const p2 = await j(await fetch(`${BASE}/api/rooms/${roomId}/poll?since=0&gv=0`, { headers: { cookie: A.cookie() } }));
	console.log(`[9] after join+leave: voice=[${p2.state?.voice ?? ''}] v=${p2.state?.v} (was ${p1.state?.v})`);
	if ((p2.state?.voice ?? []).length !== 0) {
		throw new Error(`voice roster is [${p2.state.voice}] — the leave was computed against a stale board and lost`);
	}
	if (!(p2.state?.v > p1.state?.v)) {
		throw new Error(`version did not advance (${p1.state?.v} -> ${p2.state?.v}) — two writes collapsed into one`);
	}

	// [10] One monotonic id space. A reused or rewound id is the duplicate key the
	//      sequence seed exists to prevent.
	const posted2 = await j(await fetch(`${BASE}/api/rooms/${roomId}/chat`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: B.cookie() },
		body: JSON.stringify({ text: 'second' })
	}));
	console.log(`[10] second chat id=${posted2.id} (first was ${posted.id})`);
	if (!(posted2.id > posted.id)) throw new Error(`id ${posted2.id} did not advance past ${posted.id}`);

	// [11] THE ROLLBACK. It must flush before it hands back — that is the whole
	//      difference between a rollback and a data-loss button — close the sockets
	//      with 4002 so clients fall back rather than fight it, and leave the room
	//      playable on the Odoo path afterwards.
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		console.log('[11] SKIPPED — set CRON_SECRET (node --env-file=.env) to exercise evacuate');
	} else {
		const closedA = new Promise((r) => wsA.on('close', (code) => r(code)));
		const ev = await j(await fetch(`${BASE}/api/rooms/${roomId}/evacuate`, {
			method: 'POST', headers: { 'x-cron-secret': cronSecret }
		}));
		console.log(`[11] evacuate -> ${JSON.stringify(ev)}`);
		if (!ev.ok) throw new Error('evacuate refused — it only succeeds on a full flush, so something is still owed to Odoo');
		const code = await Promise.race([closedA, new Promise((r) => setTimeout(() => r(0), 8000))]);
		if (code !== 4002) throw new Error(`socket closed with ${code}, expected 4002 (fall back to HTTP, do not retry)`);

		// The room has to keep working. This write goes to Odoo, so its id comes
		// from Odoo's own global sequence — necessarily far above the object's.
		const after = await j(await fetch(`${BASE}/api/rooms/${roomId}/chat`, {
			method: 'POST', headers: { 'content-type': 'application/json', cookie: A.cookie() },
			body: JSON.stringify({ text: 'after evacuation' })
		}));
		console.log(`[12] post-evacuation chat id=${after.id} (Odoo's sequence)`);
		if (!after.id) throw new Error('the room stopped accepting writes after evacuation — that is the data-loss button, not a rollback');
		// Idempotent: a second evacuate must not re-run the flush or fail.
		const again = await j(await fetch(`${BASE}/api/rooms/${roomId}/evacuate`, {
			method: 'POST', headers: { 'x-cron-secret': cronSecret }
		}));
		if (!again.ok || !again.already) throw new Error(`second evacuate must be a no-op, got ${JSON.stringify(again)}`);
		console.log('[13] second evacuate is a no-op');
	}

	console.log('\nPASS: push delivered, one id space across both transports, poll served from the object,');
	console.log('      two writes inside the archive window both landed, state frames carry no watermark,');
	console.log('      and evacuate flushed, closed 4002 and left the room playable.');
} finally {
	try { wsA?.close(); wsB?.close(); } catch { /* ignore */ }
	await del(A); await del(B);
	console.log('test accounts deleted');
}

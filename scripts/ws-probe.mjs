// Integration probe for the room Durable Object, against a running worker.
//
//   npx wrangler dev --port 8792 --local
//   node scripts/ws-probe.mjs http://127.0.0.1:8792
//
// Talks to the REAL worker and the REAL DO: signs up a throwaway account,
// creates a room, opens an authenticated socket, asserts the handshake, and
// deletes the account again. Complements the check:* scripts (pure units) and
// the Playwright suite (fully mocked, never touches the runtime) — neither of
// those can catch a wiring mistake between the wrapper, the binding and the DO.
//
// Node's global WebSocket cannot send cookies (web spec: no headers option),
// which is why this uses `ws`.
import WebSocket from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:8792';
const WSB = BASE.replace(/^http/, 'ws');
const j = (r) => r.json().catch(() => ({}));

const jar = [];
const keep = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0]); };
const cookie = () => jar.join('; ');

const login = `ws-probe-${Date.now()}@example.com`;
let res = await fetch(`${BASE}/api/auth/signup`, {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ name: 'WS Probe', login, password: 'testpass123' })
});
keep(res);
const who = await j(res);
if (!who.ok) throw new Error('signup failed: ' + JSON.stringify(who));

res = await fetch(`${BASE}/api/rooms`, {
	method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie() },
	body: JSON.stringify({ name: 'ws probe', gameType: 'chess', maxPlayers: 2, drawsTotal: 0, visibility: 'public' })
});
const { roomId } = await j(res);
console.log(`[1] uid ${who.user.uid}, room ${roomId}`);

res = await fetch(`${BASE}/api/rooms/${roomId}/ws-auth`, { headers: { cookie: cookie() } });
console.log(`[2] ws-auth -> ${res.status} ${JSON.stringify(await j(res)).slice(0, 100)}`);

async function cleanup() {
	await fetch(`${BASE}/api/account/delete`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie() },
		body: JSON.stringify({ confirm: 'DELETE' })
	}).catch(() => {});
}

const ws = new WebSocket(`${WSB}/api/rooms/${roomId}/ws`, { headers: { cookie: cookie() } });
const waitFor = (pred, label, ms = 10000) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
		const on = (d) => {
			const s = d.toString();
			const f = s.startsWith('{') ? JSON.parse(s) : s;
			if (pred(f)) { clearTimeout(t); ws.off('message', on); resolve(f); }
		};
		ws.on('message', on);
	});

try {
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
		setTimeout(() => reject(new Error('socket never opened')), 10000);
	});
	console.log('[3] socket OPEN (DO returned 101)');

	const hello = waitFor((f) => f.t === 'welcome' || f.t === 'resync', 'welcome');
	ws.send(JSON.stringify({ t: 'hello', cursor: 0, gv: 0, v: 1 }));
	const first = await hello;
	console.log(`[4] ${first.t} upto=${first.upto} events=${first.events?.length} members=${first.members?.length}`);
	if (first.t !== 'welcome') throw new Error('expected welcome, got ' + first.t);
	if (first.upto !== 0) throw new Error('fresh room upto must be 0, got ' + first.upto);
	if (!Array.isArray(first.events)) throw new Error('welcome.events must be an array');

	// Hibernation keepalive: 'p' is auto-answered 'o' by the runtime WITHOUT
	// waking the object. That is what keeps an idle room from billing duration.
	const pong = waitFor((f) => f === 'o', 'auto-pong', 5000);
	ws.send('p');
	await pong;
	console.log('[5] keepalive auto-response works (object stays hibernatable)');

	// While the DO is dark, an op must be refused LOUDLY rather than hang — a
	// pending ack the client waits on forever is the worse failure.
	const acked = waitFor((f) => f.t === 'ack', 'ack', 5000);
	ws.send(JSON.stringify({ t: 'op', id: 'x1', path: 'chess/move', body: {} }));
	const ack = await acked;
	console.log(`[6] dark-mode op -> ok=${ack.ok} status=${ack.status} code=${ack.code}`);
	if (ack.ok !== false || ack.status !== 501) throw new Error('op should be refused with 501 while dark');

	console.log('\nPASS: socket accepted, welcomed, auto-ponged, ops refused while dark.');
} finally {
	try { ws.close(); } catch { /* ignore */ }
	await cleanup();
	console.log('test account deleted');
}

// M2.4 timing probe: the numbers the plan says decide success, measured on the
// deployed app against real Odoo. Baseline to beat is M1's X-Dur-Ms: 685 for a
// single poll, and a measured write RTT median of 841ms.
//
//   npm run probe:timing -- https://game.deedapp.net
//
// Signs up a throwaway account, warms the room's object (hydration is once per
// lifetime and would otherwise dominate the median), then alternates polls and
// state writes and reports p50/p95 for both wall clock and the server's own
// X-Dur-Ms. Deletes the account afterwards.
//
// READ X-Odoo-Throttled ALONGSIDE THE LATENCIES. It reports 429s over total Odoo
// calls, and the call COUNT is the more interesting half: a move that still
// costs Odoo round trips has not left the hot path, whatever its latency looks
// like on an idle afternoon. This hammers back-to-back with no think time, so
// its throttle ratio is a stress figure, not what real clients see.
const BASE = process.argv[2] || 'https://game.deedapp.net';
const j = (r) => r.json().catch(() => ({}));
const jar = [];
const keep = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0]); };
const cookie = () => jar.join('; ');
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

let res = await fetch(`${BASE}/api/auth/signup`, {
	method: 'POST', headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ name: 'Timing', login: `timing-${Date.now()}@example.com`, password: 'testpass123' })
});
keep(res);
if (!(await j(res)).ok) throw new Error('signup failed');

res = await fetch(`${BASE}/api/rooms`, {
	method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie() },
	body: JSON.stringify({ name: 'timing probe', gameType: 'chess', maxPlayers: 2, drawsTotal: 0, visibility: 'public' })
});
const { roomId } = await j(res);
console.log(`room ${roomId}\n`);

const N = 15;
const pollWall = [], pollSrv = [], writeWall = [], writeSrv = [];
let throttled = null;

// Warm the object first — the very first touch pays hydration, which happens
// once per room lifetime and would otherwise dominate a 15-sample median.
await fetch(`${BASE}/api/rooms/${roomId}/poll?since=0&gv=0`, { headers: { cookie: cookie() } });
await fetch(`${BASE}/api/rooms/${roomId}/voice`, {
	method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie() },
	body: JSON.stringify({ action: 'join' })
});

for (let i = 0; i < N; i++) {
	let t = Date.now();
	let r = await fetch(`${BASE}/api/rooms/${roomId}/poll?since=0&gv=0`, { headers: { cookie: cookie() } });
	pollWall.push(Date.now() - t);
	pollSrv.push(Number(r.headers.get('x-dur-ms')) || 0);
	throttled = r.headers.get('x-odoo-throttled') ?? throttled;

	// A state write — the acting player waiting on their own move.
	t = Date.now();
	r = await fetch(`${BASE}/api/rooms/${roomId}/voice`, {
		method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie() },
		body: JSON.stringify({ action: i % 2 === 0 ? 'leave' : 'join' })
	});
	writeWall.push(Date.now() - t);
	writeSrv.push(Number(r.headers.get('x-dur-ms')) || 0);
	throttled = r.headers.get('x-odoo-throttled') ?? throttled;
}

const row = (label, a) => console.log(`  ${label.padEnd(22)} p50 ${String(med(a)).padStart(5)}ms   p95 ${String(p95(a)).padStart(5)}ms`);
console.log(`${N} samples, one client, no contention\n`);
console.log('POLL (read):');
row('wall clock', pollWall);
row('server X-Dur-Ms', pollSrv);
console.log('\nSTATE WRITE (a move):');
row('wall clock', writeWall);
row('server X-Dur-Ms', writeSrv);
console.log(`\nX-Odoo-Throttled: ${throttled}   (429s / total Odoo calls)`);
console.log('\nM1 baseline: X-Dur-Ms 685 for one poll; write RTT median 841ms.');

await fetch(`${BASE}/api/account/delete`, {
	method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie() },
	body: JSON.stringify({ confirm: 'DELETE' })
}).catch(() => {});
console.log('test account deleted');

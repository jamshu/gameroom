// Stage 0 instrumentation. The room's latency has only ever been reasoned about
// from the code, never measured, so "Odoo + Lambda is the bottleneck" is an
// inference. This collects the smallest set of numbers that can confirm or
// refute it before a platform migration is judged against them.
//
// Every measurement here uses ONE clock. Nothing diffs a server timestamp
// against a client one: gamelogic.js drops `turnStartedAt` and sends elapsed-ms
// rather than absolute stamps precisely because clock skew would swamp the
// quantity being measured, and that reasoning applies here more, not less.
//
// So instead of trying to time A's move to B's screen across two machines:
//   - writeRtt  — the actor's own POST round trip. This IS the Lambda + Odoo
//                 cost, i.e. exactly the term the migration removes.
//   - pollRtt   — the same for the read path.
//   - stateVia  — did a state version bump arrive by PUSH or by POLL? Clock-free
//                 and the sharpest signal we have for the watcher's experience:
//                 a bump discovered by poll means the push did not land and
//                 somebody waited out a safety interval up to 60s.
//   - banner    — wall-clock ms the "retrying" banner was actually on screen,
//                 which is the reported symptom itself.

// 5 minutes, not 1: each flush may become an Odoo row (see api/metrics), and
// instrumentation must not consume a meaningful share of the ~1 req/s budget it
// exists to measure. At 5 min a 4-player room costs ~0.013 req/s — noise. Short
// sessions still report, because pagehide flushes unconditionally.
const FLUSH_MS = 300000;
const SAMPLE_MAX = 200; // per histogram; bounded so a long session can't grow

const hist = new Map(); // name -> number[]
const counts = new Map(); // name -> number

let bannerSince = null;
let bannerMs = 0;
let pushSince = null;
let pushMs = 0;
let startedAt = 0;
let timer = null;
let roomId = null;

function push(map, name, value) {
	const arr = map.get(name) || [];
	// Reservoir-ish: once full, overwrite at random so the sample stays
	// representative of the whole session rather than only its first minute.
	if (arr.length < SAMPLE_MAX) arr.push(value);
	else arr[Math.floor(Math.random() * SAMPLE_MAX)] = value;
	map.set(name, arr);
}

function bump(name, by = 1) {
	counts.set(name, (counts.get(name) || 0) + by);
}

function pct(arr, p) {
	if (!arr.length) return null;
	const s = [...arr].sort((a, b) => a - b);
	return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

export function recordWriteRtt(path, ms) {
	push(hist, 'write', ms);
	push(hist, `write:${path}`, ms);
}

export function recordPollRtt(ms, serverMs) {
	push(hist, 'poll', ms);
	// The half of the round trip a platform migration can actually move. Reported
	// separately so `poll_p95 - pollSrv_p95` reads as network + queueing.
	if (typeof serverMs === 'number') push(hist, 'pollSrv', serverMs);
}

/**
 * A state version actually advanced. Three buckets, and the distinction is the
 * whole point:
 *   - 'echo' — the actor's own write, returned in its POST response. Says
 *     nothing about push health; its cost is already in writeRtt. MUST be
 *     excluded from the ratio below or a 2-player game reports ~50% "push
 *     failed" forever, before and after any migration alike.
 *   - 'push' — a watcher learned of someone else's move on the wire. Good path.
 *   - 'poll' — a watcher learned of it only because the safety poll came round.
 *     The push did not land and somebody waited, up to PUSH_SAFETY_MS.
 * push/(push+poll) is the watcher-side health number.
 */
export function recordStateArrival(via) {
	bump(`state:${via}`);
}

export function recordPollError() {
	bump('pollError');
}

/** Called on every transition so the on-screen time is integrated, not sampled. */
export function recordBanner(visible) {
	const now = Date.now();
	if (visible && bannerSince == null) bannerSince = now;
	else if (!visible && bannerSince != null) {
		bannerMs += now - bannerSince;
		bannerSince = null;
	}
}

export function recordPushConnected(connected) {
	const now = Date.now();
	if (connected && pushSince == null) pushSince = now;
	else if (!connected && pushSince != null) {
		pushMs += now - pushSince;
		pushSince = null;
	}
}

function snapshot() {
	const now = Date.now();
	const out = {
		room: roomId,
		sessionMs: now - startedAt,
		// close the open intervals without ending them, so a flush mid-banner
		// still reports the time accrued so far
		bannerMs: bannerMs + (bannerSince == null ? 0 : now - bannerSince),
		pushUpMs: pushMs + (pushSince == null ? 0 : now - pushSince)
	};
	for (const [name, arr] of hist) {
		out[`${name}_n`] = arr.length;
		out[`${name}_p50`] = pct(arr, 50);
		out[`${name}_p95`] = pct(arr, 95);
	}
	for (const [name, n] of counts) out[name] = n;
	return out;
}

function flush(final = false) {
	if (!startedAt) return;
	const body = JSON.stringify(snapshot());
	try {
		// sendBeacon survives pagehide, which fetch does not — and pagehide is the
		// single most important flush, because it is where an abandoned-in-disgust
		// session reports its numbers.
		if (final && navigator.sendBeacon) {
			navigator.sendBeacon('/api/metrics', new Blob([body], { type: 'application/json' }));
		} else {
			fetch('/api/metrics', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				keepalive: true
			}).catch(() => {});
		}
	} catch {
		/* instrumentation must never affect the room */
	}
	hist.clear();
	counts.clear();
	bannerMs = 0;
	pushMs = 0;
	if (bannerSince != null) bannerSince = Date.now();
	if (pushSince != null) pushSince = Date.now();
}

export function startMetrics(id) {
	roomId = id;
	startedAt = Date.now();
	clearInterval(timer);
	timer = setInterval(flush, FLUSH_MS);
	addEventListener('pagehide', onHide);
}

function onHide() {
	flush(true);
}

export function stopMetrics() {
	flush(true);
	clearInterval(timer);
	timer = null;
	removeEventListener('pagehide', onHide);
	startedAt = 0;
	bannerSince = null;
	pushSince = null;
}

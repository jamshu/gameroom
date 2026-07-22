/**
 * Chess clock display + flag claim, mirroring `createHold` in holdclock.svelte.js.
 *
 * The server sends REMAINING milliseconds, never an absolute timestamp, so a
 * client with a skewed clock still counts down correctly. We anchor the values
 * on receipt (keyed on the state version) and recompute from that anchor on each
 * tick — never decrement a counter, because background tabs throttle timers to
 * ≥1s and mobile Safari suspends them entirely, so a decremented value drifts
 * arbitrarily. Recomputing self-corrects the moment the tab wakes.
 *
 * `read()` returns { v, clock, result, role } where clock is { w, b, ticking }
 * and role is 'opponent' | 'mover' | { spectator: index }.
 */

// How long past local zero each party waits before claiming the win on time.
// Staggered so the normal case is exactly one request: the opponent claims,
// everyone else has already seen the result and cancelled. The later tiers only
// ever fire if the opponent's tab is closed — without them the game would hang.
const CLAIM_DELAY = { opponent: 1500, mover: 6000, spectator: 10000 };
const SPECTATOR_STAGGER = 1000;
const TICK_MS = 250;

export function createChessClock(read, onFlag) {
	let anchor = $state(null); // { at, w, b, ticking }
	let now = $state(Date.now());
	let anchoredV = null; // plain let — must not feed the effect that sets it
	let ticker = null;
	let claimTimer = null;

	function clearClaim() {
		clearTimeout(claimTimer);
		claimTimer = null;
	}

	// (Re-)anchor whenever the server state version moves. Between versions the
	// countdown is fully deterministic — only a move changes a clock, and a move
	// always bumps the version — so holding an anchor for minutes stays accurate.
	$effect(() => {
		const { v, clock, result } = read();
		if (!clock) return;
		if (v === anchoredV) return;
		anchoredV = v;
		clearClaim();
		clearInterval(ticker);
		ticker = null;
		anchor = { at: Date.now(), w: clock.w, b: clock.b, ticking: result ? null : clock.ticking };
		now = Date.now();
		if (!anchor.ticking) return;
		ticker = setInterval(() => (now = Date.now()), TICK_MS);
	});

	// Arm the flag claim when the ticking side reaches zero locally. The server
	// re-verifies, so an early or hostile claim can't steal a game.
	$effect(() => {
		const a = anchor;
		const t = now;
		if (!a?.ticking) {
			clearClaim();
			return;
		}
		const left = Math.max(0, a[a.ticking] - (t - a.at));
		if (left > 0) {
			clearClaim();
			return;
		}
		if (claimTimer) return; // already armed
		const { role } = read();
		const delay =
			role === 'opponent'
				? CLAIM_DELAY.opponent
				: role === 'mover'
					? CLAIM_DELAY.mover
					: CLAIM_DELAY.spectator + SPECTATOR_STAGGER * (Number(role?.spectator) || 0);
		claimTimer = setTimeout(() => {
			claimTimer = null;
			onFlag?.();
		}, delay);
	});

	$effect(() => () => {
		clearInterval(ticker);
		clearTimeout(claimTimer);
	});

	function remaining(color) {
		const a = anchor;
		if (!a) return null;
		const burnt = a.ticking === color ? now - a.at : 0;
		return Math.max(0, a[color] - burnt);
	}

	return {
		get w() {
			return remaining('w');
		},
		get b() {
			return remaining('b');
		},
		get ticking() {
			return anchor?.ticking ?? null;
		}
	};
}

/** ms -> "m:ss", or "0:00.0" under ten seconds so the last seconds read clearly. */
export function formatClock(ms) {
	if (ms == null) return '—';
	const total = Math.max(0, ms);
	const m = Math.floor(total / 60000);
	const s = Math.floor((total % 60000) / 1000);
	if (total < 10000) {
		return `${m}:${String(s).padStart(2, '0')}.${Math.floor((total % 1000) / 100)}`;
	}
	return `${m}:${String(s).padStart(2, '0')}`;
}

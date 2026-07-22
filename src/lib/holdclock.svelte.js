/**
 * Countdown for a server-issued hold window.
 *
 * `read()` returns `{ key, ms }`. The server sends the *remaining* milliseconds
 * rather than an absolute timestamp, so we anchor against the local clock the
 * moment it arrives — a skewed client clock still counts down correctly.
 *
 * `key` identifies the round. The poll hands us a fresh game object every time
 * the state version moves, so anchoring on value alone would restart the
 * countdown over and over and it would never reach zero. We anchor once per
 * key and ignore everything else.
 */
export function createHold(read) {
	let until = $state(0);
	let now = $state(0);
	// plain lets on purpose: the effect must not depend on what it writes
	let anchored = null;
	let ticker = null;

	$effect(() => {
		const { key, ms } = read();
		if (key === anchored) return; // same round — leave the running clock alone
		anchored = key;
		clearInterval(ticker);
		ticker = null;

		if (key == null || !(ms > 0)) {
			until = 0;
			now = 0;
			return;
		}
		const end = Date.now() + ms;
		until = end;
		now = Date.now();
		ticker = setInterval(() => {
			now = Date.now();
			if (now >= end) {
				clearInterval(ticker);
				ticker = null;
			}
		}, 250);
	});

	// stop the ticker when the component goes away
	$effect(() => () => clearInterval(ticker));

	return {
		/**
		 * True from the instant the round becomes holdable until the window
		 * closes — including the render pass *before* the effect above has
		 * anchored. Without that leading edge the caller sees one frame of
		 * "not holding" and swaps the UI out and straight back in.
		 */
		get holding() {
			const { key } = read();
			if (key == null) return false;
			if (anchored !== key) return true; // effect hasn't caught up yet
			return until > 0 && now < until;
		},
		get active() {
			return until > 0 && now < until;
		},
		get secondsLeft() {
			return until > 0 ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
		}
	};
}

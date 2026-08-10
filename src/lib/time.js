// Chat timestamp formatting. Intl only — no date library, nothing to bundle.
//
// Formatter objects are built ONCE at module scope. `new Intl.DateTimeFormat()`
// is one of the more expensive constructors in the platform (it resolves locale
// data every time), and the chat panel formats every visible row on every
// re-render — building one per message showed up as jank on a long history.

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Clock time for a single message: "14:32". */
export function timeOfDay(ts) {
	if (!ts) return '';
	return timeFmt.format(new Date(ts));
}

/** Same calendar day in the VIEWER's timezone — not UTC, not the sender's. */
export function sameDay(a, b) {
	if (!a || !b) return false;
	const x = new Date(a);
	const y = new Date(b);
	return (
		x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
	);
}

/**
 * Heading for a day separator: "Today", "Yesterday", or "12 Aug 2026".
 *
 * Yesterday is computed by walking a Date object back one day rather than
 * subtracting 86_400_000 ms, so it stays correct across DST transitions — on the
 * two days a year that are 23 or 25 hours long, the arithmetic version labels
 * the wrong day.
 */
export function dayLabel(ts) {
	if (!ts) return '';
	const now = new Date();
	if (sameDay(ts, now)) return 'Today';
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (sameDay(ts, yesterday)) return 'Yesterday';
	return dateFmt.format(new Date(ts));
}

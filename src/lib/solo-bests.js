// Personal bests for the solo games, in localStorage.
//
// Solo play is deliberately local-only: no room, no Durable Object, no Odoo row
// (see the plan). That keeps it instant and playable offline, and it means these
// numbers are the ONLY record a solo player has — so every read is defensive.
// A thrown exception here would take the game page down with it.
//
// Storage can fail for reasons that have nothing to do with us: Safari private
// browsing throws on setItem, embedded webviews disable it entirely, and a user
// can wipe it mid-session. All of that degrades to "no best yet", never a crash.
// Room scores are unaffected — those live in Odoo via finishRoom.

const KEY = 'gr:solo-bests:v1';

/** Everything, or `{}` — parse failures included (a hand-edited or truncated
 *  entry must not brick the page). */
function readAll() {
	try {
		const raw = localStorage.getItem(KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		// JSON.parse('null'), '"x"' and '[]' all parse without throwing
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeAll(all) {
	try {
		localStorage.setItem(KEY, JSON.stringify(all));
		return true;
	} catch {
		return false; // quota, private mode, disabled storage — the game plays on
	}
}

/* Sudoku is a time trial (lower is better); match-3 is a score (higher is
   better). Keeping the direction with the key rather than at each call site is
   what stops a copy-paste from silently recording a WORSE best as an
   improvement — the bug would only show up as a best that never budges. */
// Blackjack records a higher-is-better metric (win streak) — the same direction as
// match3, listed explicitly so a future copy-paste can't silently record a worse
// "best" as an improvement.
const LOWER_IS_BETTER = { sudoku: true, match3: false, blackjack: false };

const slotKey = (game, variant) => `${game}:${variant ?? 'default'}`;

/**
 * The best recorded for a game/variant, or `null` if there isn't one.
 * `variant` is the sudoku difficulty; match-3 has a single slot.
 */
export function getBest(game, variant) {
	const v = readAll()[slotKey(game, variant)];
	return Number.isFinite(v?.value) ? v : null;
}

/**
 * Record `value` if it beats the stored best. Returns
 * `{ best, improved }` so the caller can celebrate a new record without
 * re-reading — `improved` is false both when the run was worse AND when storage
 * refused the write, because in neither case is there a new record to show.
 */
export function recordBest(game, variant, value) {
	if (!Number.isFinite(value)) return { best: getBest(game, variant), improved: false };

	const all = readAll();
	const key = slotKey(game, variant);
	const prev = all[key];
	const lower = LOWER_IS_BETTER[game] ?? false;
	const isBetter =
		!Number.isFinite(prev?.value) || (lower ? value < prev.value : value > prev.value);

	if (!isBetter) return { best: prev, improved: false };

	const next = { value, at: Date.now() };
	all[key] = next;
	if (!writeAll(all)) return { best: prev ?? null, improved: false };
	return { best: next, improved: true };
}

/** Every stored best, for a "your records" panel. */
export function allBests() {
	const all = readAll();
	return Object.entries(all)
		.filter(([, v]) => Number.isFinite(v?.value))
		.map(([key, v]) => {
			const [game, variant] = key.split(':');
			return { game, variant, value: v.value, at: v.at ?? null };
		});
}

/** Wipe every solo record. */
export function clearBests() {
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* nothing to do — the page must not fail on a storage error */
	}
}

/** mm:ss for a duration in ms. Shared by the solo pages and the race UI. */
export function formatDuration(ms) {
	const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

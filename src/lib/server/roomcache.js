// Generic per-key snapshot cache with TTL + in-flight coalescing. Dependency-free
// (no Odoo import) so it's unit-testable in isolation. Used to collapse the
// identical room+members reads that every client's poll would otherwise issue.
export function createSnapshotCache(fetcher, ttlMs) {
	const entries = new Map(); // key -> { at, value, inflight }

	async function get(key, { fresh = false } = {}) {
		const e = entries.get(key);
		// share an in-flight fetch so concurrent misses hit Odoo once
		if (!fresh && e?.inflight) return e.inflight;
		if (!fresh && e && !e.inflight && Date.now() - e.at < ttlMs) return e.value;

		const inflight = Promise.resolve().then(() => fetcher(key));
		entries.set(key, { at: e?.at ?? 0, value: e?.value, inflight });
		try {
			const value = await inflight;
			entries.set(key, { at: Date.now(), value, inflight: null });
			return value;
		} catch (err) {
			entries.delete(key); // never cache a failure — next call retries fresh
			throw err;
		}
	}

	return { get };
}

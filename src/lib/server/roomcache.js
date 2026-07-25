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
		// Identity, not just the key: invalidate() can drop this entry while the
		// fetch is still running, and seating the result anyway would re-cache data
		// read BEFORE the write that invalidated it — defeating the invalidation and
		// pinning the stale value for another full TTL.
		const mine = { at: e?.at ?? 0, value: e?.value, inflight };
		entries.set(key, mine);
		try {
			const value = await inflight;
			if (entries.get(key) === mine) entries.set(key, { at: Date.now(), value, inflight: null });
			return value;
		} catch (err) {
			// never cache a failure — next call retries fresh. Same identity guard, so
			// a failing fetch can't evict a newer entry that replaced it.
			if (entries.get(key) === mine) entries.delete(key);
			throw err;
		}
	}

	/**
	 * Drop a key so the next get() refetches. The TTL alone is not enough after a
	 * write: a read issued inside the remaining window would still be served the
	 * pre-write value. Also clears any in-flight fetch, which by definition started
	 * before the write and would resolve to stale data.
	 */
	function invalidate(key) {
		entries.delete(key);
	}

	return { get, invalidate };
}

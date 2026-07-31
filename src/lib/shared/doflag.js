// Which rooms are served by a Durable Object.
//
// Takes the flag STRING as an argument rather than reading env, because both
// sides need this answer and only one of them has `$env`: the SvelteKit routes
// read it from `$env/dynamic/private`, the DO and the generated worker wrapper
// read it from the raw `env` binding. One rule, two callers, no drift.
//
// Deterministic on roomId, and that is load-bearing: `pct:N` must be STICKY per
// room. A room that flipped in and out between requests would mean state lived
// in two places within a single game, which is the split brain the whole
// rollout plan exists to avoid. Never make this random or time-based.

/**
 * @param {number|string} roomId
 * @param {string|undefined} flag  'off' | 'all' | '1,7,42' | 'pct:20'
 */
export function isDoRoom(roomId, flag) {
	const id = Number(roomId);
	const f = String(flag ?? '').trim().toLowerCase();
	if (!f || f === 'off' || f === 'false' || f === '0') return false;
	if (f === 'all' || f === 'true' || f === '1') return true;

	if (f.startsWith('pct:')) {
		const pct = Number(f.slice(4));
		if (!Number.isFinite(pct) || pct <= 0) return false;
		if (pct >= 100) return true;
		// A cheap integer hash, not `id % 100`: room ids are sequential, so the
		// modulo would hand every consecutive block of rooms the same verdict and
		// a 20% rollout would be 20 neighbours rather than a spread sample.
		const h = (Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0) % 100;
		return h < pct;
	}

	// explicit id list
	return f.split(',').some((part) => Number(part.trim()) === id);
}

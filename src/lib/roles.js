/* Thief Finder role identity — emoji and meme art.
   Keys must stay in sync with ROLE_LADDER in src/lib/server/gamelogic.js plus
   the 'Thief' / 'Police' literals it prepends to every deck. */

export const ROLE_EMOJI = {
	King: '👑', Queen: '👸', Minister: '🎩', Soldier: '⚔️', Sepoy: '🪖',
	Guard: '🛡️', Farmer: '🌾', Trader: '⚖️', Barber: '✂️', Cobbler: '🥾',
	Police: '👮', Thief: '🥷'
};

/* Role → meme face. Partial by design: a role with no entry — or one whose file
   isn't on disk yet — falls back to its emoji, so the set can be filled in one
   face at a time and never renders a broken image. PNG, because the service
   worker precache glob in vite.config.js covers png but not jpg/webp.
   Filenames are keyed by role, not by actor: which face lands on Police vs
   Thief is decided by what you drop into static/roles/. */
export const ROLE_ART = {
	Police: '/roles/police.png',
	Thief: '/roles/thief.png'
};

/* A path that 404s is remembered for the session rather than per component
   instance — half a dozen RoleArt instances live inside keyed {#each} blocks and
   would otherwise each re-request the same missing file on every re-render. */
const dead = new Set();

/** Art path for a role, or null when there's none to show (fall back to emoji). */
export function artSrc(role) {
	if (!role || dead.has(role)) return null;
	return ROLE_ART[role] || null;
}

/** Called by RoleArt when an image fails to load. */
export function markDead(role) {
	if (role) dead.add(role);
}

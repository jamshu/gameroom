// Test-only loader: lets room.js be imported under plain node so its role/seat
// helpers run for real (see room-check.js). Replaces the two side-effecting deps
// they pull in at module-eval time — Odoo I/O and the realtime publisher — with
// in-memory stubs, and satisfies SvelteKit's $env virtual module. Not part of
// the app build.
//
// `adminExecute` records every call into globalThis.__odooCalls so a check can
// assert the exact writes a helper issued.
export async function resolve(specifier, context, next) {
	if (specifier === '$env/dynamic/private') return { url: 'stub:env', shortCircuit: true };
	if (specifier.endsWith('/odoo.js')) return { url: 'stub:odoo', shortCircuit: true };
	if (specifier.endsWith('/realtime.js')) return { url: 'stub:realtime', shortCircuit: true };
	// dostub.js reaches the Durable Object binding through $app/server, which does
	// not resolve outside SvelteKit. Stubbing it is also what lets room-check drive
	// the DO write path: queue replies in __doResults and read back __doOps.
	if (specifier.endsWith('/dostub.js')) return { url: 'stub:dostub', shortCircuit: true };
	return next(specifier, context);
}

export async function load(url, context, next) {
	if (url === 'stub:env') {
		return { format: 'module', shortCircuit: true, source: 'export const env = process.env;' };
	}
	if (url === 'stub:odoo') {
		return {
			format: 'module',
			shortCircuit: true,
			source: `
				globalThis.__odooCalls = [];
				// Queued results, for helpers that READ before they decide (media
				// ownership, cascade deletes). Shift one per call; fall through to the
				// defaults once empty, so existing checks are unaffected.
				globalThis.__odooResults = [];
				export async function adminExecute(model, method, args, kw) {
					globalThis.__odooCalls.push({ model, method, args, kw });
					if (globalThis.__odooResults.length) return globalThis.__odooResults.shift();
					// create returns an id; everything else the helpers ignore
					if (method === 'create') return 1;
						// the search family always returns a LIST in Odoo, and callers map
						// over it (getMembers) — model that rather than a bare truthy
						if (method === 'search' || method === 'search_read') return [];
						return true;
				}
				export function assertConfigured() {}
				// auth.js imports these at eval time; the check never calls them
				export function sessionInfo() {}
				export function buildSessionContext() {}
			`
		};
	}
	if (url === 'stub:realtime') {
		return {
			format: 'module',
			shortCircuit: true,
			source: `
				// recorded, like __odooCalls, so a check can assert what the room
				// actually announced rather than only what it wrote
				globalThis.__pushedRosters = [];
				export async function publishState() {}
				export async function publishEvent() {}
				export async function publishRoster(roomId, payload) {
					globalThis.__pushedRosters.push({ roomId, ...payload });
				}
			`
		};
	}
	if (url === 'stub:dostub') {
		return {
			format: 'module',
			shortCircuit: true,
			source: `
				globalThis.__doOps = [];
				// Queued replies, one per op. Empty means "the object did not answer",
				// which is the null doOp returns for an unreachable binding — and the
				// case every write path has to FAIL on rather than fall back to Odoo.
				globalThis.__doResults = [];
				export async function doOp(roomId, op) {
					globalThis.__doOps.push({ roomId: Number(roomId), ...op });
					return globalThis.__doResults.length ? globalThis.__doResults.shift() : null;
				}
				export function roomStub() { return null; }
				export const isEvacuated = (res) => res?.ok === false && res?.error === 'evacuated';
			`
		};
	}
	return next(url, context);
}

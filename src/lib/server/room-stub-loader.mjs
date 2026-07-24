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
				export async function adminExecute(model, method, args, kw) {
					globalThis.__odooCalls.push({ model, method, args, kw });
					// create returns an id; everything else the helpers ignore
					return method === 'create' ? 1 : true;
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
				export async function publishState() {}
				export async function publishEvent() {}
			`
		};
	}
	return next(url, context);
}

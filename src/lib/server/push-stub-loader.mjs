// Test-only loader: lets push.js be imported under plain node so its WebCrypto
// encryption runs for real against the RFC vector (see push-check.js). Stubs the
// two SvelteKit env virtuals and the Odoo client — the crypto is the thing under
// test, and it has no Odoo dependency. Not part of the app build.
export async function resolve(specifier, context, next) {
	if (specifier === '$env/dynamic/private' || specifier === '$env/dynamic/public') {
		return { url: 'stub:env', shortCircuit: true };
	}
	if (specifier.endsWith('/odoo.js')) return { url: 'stub:odoo', shortCircuit: true };
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
					if (method === 'create') return 1;
					if (method === 'search' || method === 'search_read') return [];
					return true;
				}
				export function assertConfigured() {}
			`
		};
	}
	return next(url, context);
}

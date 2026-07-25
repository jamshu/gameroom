// Test-only loader: lets api.js be imported under plain node (see api-check.js).
// It pulls in two SvelteKit-only modules at eval time — the navigation helper and
// the auth store — neither of which the offline path touches. Not part of the app
// build. Mirrors src/lib/server/room-stub-loader.mjs.
export async function resolve(specifier, context, next) {
	if (specifier === '$app/navigation') return { url: 'stub:nav', shortCircuit: true };
	if (specifier.endsWith('/stores/auth.js')) return { url: 'stub:auth', shortCircuit: true };
	return next(specifier, context);
}

export async function load(url, context, next) {
	if (url === 'stub:nav') {
		return {
			format: 'module',
			shortCircuit: true,
			source: `
				globalThis.__gotos = [];
				export function goto(p) { globalThis.__gotos.push(p); }
			`
		};
	}
	if (url === 'stub:auth') {
		// svelte/store's get() only needs a subscribe that calls back synchronously
		return {
			format: 'module',
			shortCircuit: true,
			source: `export const user = { subscribe: (fn) => { fn(null); return () => {}; } };`
		};
	}
	return next(url, context);
}

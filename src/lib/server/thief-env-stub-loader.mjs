// Test-only module loader: satisfies SvelteKit's `$env/dynamic/private` virtual
// module so server logic can be imported under plain node (see
// thief-claims-check.js). Not part of the app build.
export async function resolve(specifier, context, next) {
	if (specifier === '$env/dynamic/private') return { url: 'stub:env', shortCircuit: true };
	return next(specifier, context);
}
export async function load(url, context, next) {
	if (url === 'stub:env') {
		return { format: 'module', shortCircuit: true, source: 'export const env = process.env;' };
	}
	return next(url, context);
}

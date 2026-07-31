// Test-only module loader: satisfies SvelteKit's `$env/dynamic/private` virtual
// module so server logic can be imported under plain node (see
// thief-claims-check.js). Not part of the app build.
export async function resolve(specifier, context, next) {
	if (specifier === '$env/dynamic/private') return { url: 'stub:env', shortCircuit: true };
	if (specifier === '$app/server') return { url: 'stub:appserver', shortCircuit: true };
	return next(specifier, context);
}
export async function load(url, context, next) {
	if (url === 'stub:env') {
		return { format: 'module', shortCircuit: true, source: 'export const env = process.env;' };
	}
	if (url === 'stub:appserver') {
		// realtime.js reads the ROOM binding off the RequestEvent. Outside a request
		// SvelteKit's own getRequestEvent throws, so the stub does too — which is
		// the honest behaviour and the case realtime.js already guards for.
		return {
			format: 'module',
			shortCircuit: true,
			source: `export function getRequestEvent() { throw new Error('no request event in a check script'); }`
		};
	}
	return next(url, context);
}

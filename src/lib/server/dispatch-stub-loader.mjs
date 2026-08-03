// Test-only loader for dispatch-check: satisfies SvelteKit's $env virtual module
// and replaces the Durable Object binding with a recorder, so the check can
// assert exactly which ops the four publish* names emitted.
export async function resolve(specifier, context, next) {
	if (specifier === '$env/dynamic/private') return { url: 'stub:env', shortCircuit: true };
	if (specifier.endsWith('/dostub.js')) return { url: 'stub:dostub', shortCircuit: true };
	return next(specifier, context);
}

export async function load(url, context, next) {
	if (url === 'stub:env') {
		// By reference, so a check can flip DO_ROOMS between assertions.
		return { format: 'module', shortCircuit: true, source: 'export const env = process.env;' };
	}
	if (url === 'stub:dostub') {
		return {
			format: 'module',
			shortCircuit: true,
			source: `
				globalThis.__doOps = [];
				export async function doOp(roomId, op) {
					globalThis.__doOps.push({ roomId: Number(roomId), ...op });
					return { ok: true };
				}
				export function roomStub() { return null; }
				export const isEvacuated = (res) => res?.ok === false && res?.error === 'evacuated';
			`
		};
	}
	return next(url, context);
}

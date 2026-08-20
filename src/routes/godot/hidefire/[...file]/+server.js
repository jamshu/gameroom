// Serve the Godot Hide & Fire web export same-origin.
//
// WHY NOT STATIC ASSETS: the engine .wasm is ~38 MB and Workers Assets caps a
// single file at 25 MiB. So the bundle lives in the R2 bucket `gameroom-assets`
// under `hidefire/` and is streamed through this route via the GODOT_R2 binding
// — same origin as the app, so no CORS and no public bucket. See wrangler.toml.
//
// CATCH-ALL + VERSION SEGMENT: the loader requests `/godot/hidefire/<ver>/<file>`
// (see HideFireArena ENGINE_BASE). We ignore the version and serve `<file>` — the
// version only exists to bust the immutable browser cache when the export changes
// (fixed filenames + `immutable` would otherwise pin a stale wasm/pck forever).
//
// `vite dev` has no bindings, so it falls back to the local export on disk
// (godot/hidefire/build/web). `wrangler dev` gets the binding but the objects
// live in REMOTE R2 — run it with `--remote` to load them.

export const prerender = false;

const R2_PREFIX = 'hidefire/';
const LOCAL_DIR = 'godot/hidefire/build/web';

const TYPES = {
	wasm: 'application/wasm',
	js: 'text/javascript',
	pck: 'application/octet-stream',
	html: 'text/html',
	png: 'image/png',
	json: 'application/json'
};
const ctype = (name) => TYPES[name.split('.').pop()] || 'application/octet-stream';
// Safe to pin hard now: the path carries a version, so a changed export is a
// different URL. (Without the version this would serve a stale pck forever.)
const CACHE = 'public, max-age=31536000, immutable';

// params.file is the catch-all — e.g. "v17/hidefire.wasm" or "hidefire.wasm".
const basename = (p) => String(p).split('/').pop();

export async function GET({ params, platform }) {
	const name = basename(params.file);
	const r2 = platform?.env?.GODOT_R2;
	if (r2) {
		const obj = await r2.get(R2_PREFIX + name);
		if (!obj) return new Response('Not found', { status: 404 });
		return new Response(obj.body, {
			headers: { 'content-type': ctype(name), 'cache-control': CACHE }
		});
	}
	// Dev (vite): read the local export straight off disk.
	try {
		const { readFile } = await import('node:fs/promises');
		const buf = await readFile(`${process.cwd()}/${LOCAL_DIR}/${name}`);
		return new Response(buf, { headers: { 'content-type': ctype(name) } });
	} catch {
		return new Response('Not found', { status: 404 });
	}
}

// The component HEAD-probes hidefire.js before booting the engine.
export async function HEAD({ params, platform }) {
	const name = basename(params.file);
	const r2 = platform?.env?.GODOT_R2;
	if (r2) {
		const head = await r2.head(R2_PREFIX + name);
		return new Response(null, { status: head ? 200 : 404 });
	}
	try {
		const { stat } = await import('node:fs/promises');
		await stat(`${process.cwd()}/${LOCAL_DIR}/${name}`);
		return new Response(null, { status: 200 });
	} catch {
		return new Response(null, { status: 404 });
	}
}

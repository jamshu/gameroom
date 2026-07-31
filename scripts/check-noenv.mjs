// Guards the one error class that otherwise only surfaces at `wrangler deploy`.
//
// `src/lib/shared/` and `src/lib/do/` are bundled by wrangler for the Durable
// Object, OUTSIDE the SvelteKit build. In that bundle there is no `$lib` alias
// and no `$env/*` virtual module. A stray `$lib/...` or `$env/dynamic/private`
// import there does not fail the vite build, does not fail any check script and
// does not fail `npm run dev` — it fails when you deploy, or worse, at runtime
// inside a DO where the only symptom is a room that never connects.
//
// Ten lines to make that impossible. Run from `check:all`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src/lib/shared', 'src/lib/do'];
const BANNED = /(^|[^\w])(\$lib|\$env)\//;

function walk(dir) {
	let out = [];
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out; // directory not created yet — not an error
	}
	for (const name of entries) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out = out.concat(walk(p));
		else if (p.endsWith('.js')) out.push(p);
	}
	return out;
}

const bad = [];
for (const root of ROOTS) {
	for (const file of walk(root)) {
		readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
			// only import/export specifiers matter; a prose mention in a comment is fine
			if (!/^\s*(import|export)\b/.test(line)) return;
			if (BANNED.test(line)) bad.push(`${file}:${i + 1}  ${line.trim()}`);
		});
	}
}

if (bad.length) {
	console.error('check:noenv FAILED — these are bundled outside SvelteKit and cannot resolve $lib/$env:\n');
	for (const b of bad) console.error('  ' + b);
	console.error('\nUse a relative specifier instead.');
	process.exit(1);
}
console.log('check-noenv: shared/ and do/ are free of $lib and $env imports');

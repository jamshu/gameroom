// Bake build-time env vars into the Amplify SSR compute bundle.
//
// Amplify console env vars exist only in the BUILD environment. The SSR compute
// Lambda's process.env is otherwise empty, so $env/dynamic/private (Odoo creds)
// resolves to undefined at request time -> "Odoo is not configured".
//
// handler.js imports shims.js before it calls server.init({ env: process.env }),
// so prepending an Object.assign(process.env, ...) to shims.js puts the values in
// process.env before SvelteKit reads them. Run this AFTER `npm run build`.
//
// Security: these secrets end up in the deployment artifact, readable by anyone
// with Amplify access. That is the documented AWS tradeoff for SSR runtime env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const KEYS = ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY', 'CF_TURN_KEY_ID', 'CF_TURN_API_TOKEN'];

const file = 'build/compute/default/shims.js';
if (!existsSync(file)) throw new Error(`${file} not found — run after \`npm run build\``);

const baked = {};
for (const k of KEYS) {
	const v = process.env[k];
	if (v != null && v !== '') baked[k] = v;
}

// Adapter caps request bodies at 512KB by default; avatar base64 uploads need
// more. Plain byte count (adapter uses parseInt). Lambda's own ~6MB ceiling
// still applies above this.
baked.BODY_SIZE_LIMIT = process.env.BODY_SIZE_LIMIT || '10485760'; // 10MB

const prefix = `Object.assign(process.env, ${JSON.stringify(baked)});\n`;
writeFileSync(file, prefix + readFileSync(file, 'utf8'));
console.log(`Baked ${Object.keys(baked).length} env vars into ${file}: ${Object.keys(baked).join(', ')}`);

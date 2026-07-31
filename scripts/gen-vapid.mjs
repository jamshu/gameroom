// Generate a VAPID key pair for web push.
//
// Replaces `npx web-push generate-vapid-keys`: that package was removed when
// push moved to WebCrypto (it needs node's crypto/https/stream, which a Workers
// runtime does not have). Same output format — base64url, unpadded:
//   public  = uncompressed P-256 point (65 bytes, 0x04 || x || y)
//   private = the raw private scalar d (32 bytes)
//
// ONLY for a fresh setup. If Odoo already holds a pair
// (ir.config_parameter: mail.web_push_vapid_public_key / _private_key) you MUST
// reuse it — Odoo signs its own notifications with those, existing browser
// subscriptions are bound to them, and the app's claimOdooVapid() deliberately
// never overwrites. A new pair there means every existing subscription silently
// stops working.
//
// Run: node scripts/gen-vapid.mjs
const toB64u = (u8) =>
	Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => {
	const b = s.replace(/-/g, '+').replace(/_/g, '/');
	return Uint8Array.from(Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64'));
};

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const priv = fromB64u(jwk.d);

if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('unexpected public key shape');
if (priv.length !== 32) throw new Error('unexpected private key length');

console.log('\nAdd to .env (and set the same as Cloudflare secrets):\n');
console.log(`VAPID_SUBJECT=https://your-domain`);
console.log(`VAPID_PUBLIC_KEY=${toB64u(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${toB64u(priv)}`);
console.log(`PUBLIC_VAPID_PUBLIC_KEY=${toB64u(pub)}`);
console.log(
	'\nPUBLIC_VAPID_PUBLIC_KEY is the same value as VAPID_PUBLIC_KEY — it is read\n' +
		'through $env/dynamic/public so the browser can receive it via /_app/env.js.\n'
);

// Known-answer + round-trip tests for the WebCrypto web-push implementation.
//
// This exists because getting RFC 8291 subtly wrong fails SILENTLY: the push
// service accepts the request, returns 201, and the notification simply never
// appears on the device. There is no error to read. The only way to know the
// encryption is right before shipping is to reproduce the RFC's published
// vector byte for byte.
//
// Two independent tests, and the pair is the point:
//   1. RFC vector  — catches a MISREADING of the spec (wrong info string, wrong
//                    key order, wrong header layout).
//   2. Round trip  — catches an IMPLEMENTATION bug, by decrypting with the
//                    inverse derivation and checking the plaintext comes back.
// A bug in how I read the spec would pass (2) and fail (1); a coding slip would
// usually fail both. Which one breaks tells you where to look.
//
// Run: npm run check:push
import assert from 'node:assert';
import { register } from 'node:module';

// register(), not --import: the hooks have to be installed before push.js is
// resolved, which is why the import below is dynamic.
register('./push-stub-loader.mjs', import.meta.url);

const { encryptPayload } = await import('./push.js');

/* ---- helpers (duplicated on purpose: a test that imports the code under test's
   own helpers cannot catch a bug in them) ---------------------------------- */

function b64u(s) {
	const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
function toB64u(bytes) {
	let bin = '';
	const b = new Uint8Array(bytes);
	for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function cat(...parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
const utf8 = (s) => new TextEncoder().encode(s);

async function importEcdh(pubB64, privB64, usages) {
	const pub = b64u(pubB64);
	const jwk = {
		kty: 'EC', crv: 'P-256',
		x: toB64u(pub.subarray(1, 33)),
		y: toB64u(pub.subarray(33, 65)),
		ext: true
	};
	if (privB64) jwk.d = toB64u(b64u(privB64));
	return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, usages);
}

async function hkdf(salt, ikm, info, len) {
	const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	return new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8)
	);
}

/* ---- 1. RFC 8291 section 5 known answer ---------------------------------- */

// Every value below is copied from the RFC's worked example.
const RFC = {
	plaintext: 'When I grow up, I want to be a watermelon',
	uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
	uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
	authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
	asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
	asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
	salt: 'DGv6ra1nlYgDCS1FRnbzlw',
	expected:
		'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6Tlz' +
		'AC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};

{
	const keyPair = {
		privateKey: await importEcdh(RFC.asPublic, RFC.asPrivate, ['deriveBits']),
		publicKey: await importEcdh(RFC.asPublic, null, [])
	};
	const body = await encryptPayload(utf8(RFC.plaintext), RFC.uaPublic, RFC.authSecret, {
		keyPair,
		salt: b64u(RFC.salt)
	});
	assert.strictEqual(
		toB64u(body),
		RFC.expected,
		'aes128gcm body does not match RFC 8291 §5 — the encryption is wrong and pushes would silently never display'
	);
}

/* ---- 2. round trip against a freshly generated subscription -------------- */

{
	const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
	const authSecret = crypto.getRandomValues(new Uint8Array(16));
	const message = JSON.stringify({ title: 'Your turn', body: 'Ludo — room 42' });

	const body = await encryptPayload(utf8(message), toB64u(uaPublic), toB64u(authSecret));

	// Decrypt exactly as a browser would: parse the aes128gcm header, redo the
	// derivation from the UA side, and open the record.
	const salt = body.subarray(0, 16);
	const idLen = body[20];
	const asPublic = body.subarray(21, 21 + idLen);
	const ciphertext = body.subarray(21 + idLen);
	assert.strictEqual(new DataView(body.buffer, body.byteOffset, 24).getUint32(16), 4096, 'record size header');
	assert.strictEqual(idLen, 65, 'key id length must be an uncompressed P-256 point');

	const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256)
	);
	const prk = await hkdf(authSecret, shared, cat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
	const cek = await hkdf(salt, prk, utf8('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, prk, utf8('Content-Encoding: nonce\0'), 12);
	const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
	const opened = new Uint8Array(
		await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, ciphertext)
	);

	assert.strictEqual(opened[opened.length - 1], 0x02, 'last record must carry the 0x02 delimiter');
	assert.strictEqual(new TextDecoder().decode(opened.subarray(0, -1)), message, 'round-trip plaintext');
}

/* ---- 3. a malformed subscription must not throw -------------------------- */

{
	const { sendPush } = await import('./push.js');
	// No keys at all: the row is junk. This must return quietly rather than
	// reject, because sendToUser fans out with allSettled and a throw here used
	// to be indistinguishable from a delivery failure.
	await sendPush({ endpoint: 'https://example.com/x' }, { title: 'x' });
	await sendPush(null, { title: 'x' });
}

console.log('push-check: all assertions passed');

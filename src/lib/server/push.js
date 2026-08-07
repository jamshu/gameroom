// Web push (VAPID) via Odoo's native mail.push.device. Subscriptions are
// partner-keyed; `keys` is a JSON string {p256dh, auth}. Odoo pushes to the same
// rows for its own notifications, so it must sign with the same VAPID pair.
//
// Implemented directly on WebCrypto + fetch rather than the `web-push` package.
// That package is not portable to a Workers runtime — it reaches for node's
// `crypto` (createECDH), `https`, `stream` and `jws` transitively, and shimming
// that stack is not something to bet a deploy on. The actual protocol is small:
//   - RFC 8292 — a VAPID ES256 JWT in the Authorization header
//   - RFC 8291 — aes128gcm payload encryption
// Both are pure WebCrypto, so this file now runs unchanged on Node and workerd.
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { adminExecute } from './odoo.js';

const DEVICE_MODEL = 'mail.push.device';
const RECORD_SIZE = 4096;
const TTL_SECONDS = 86400;
// 12h. The spec caps VAPID JWT lifetime at 24h; half that leaves room for clock
// skew between us and a push service without needing a per-send fresh token.
const JWT_TTL_SECONDS = 12 * 3600;

const deviceToSub = (d) => {
	let keys = {};
	try {
		keys = JSON.parse(d.keys || '{}');
	} catch {
		/* malformed row — the send will fail and clean it up */
	}
	return { endpoint: d.endpoint, keys };
};

/* ---- byte helpers ---------------------------------------------------------
   base64url everywhere: VAPID keys, subscription keys and JWT segments all use
   it, and it is NOT the same alphabet as base64 (-_ vs +/, no padding). */

function b64urlToBytes(s) {
	const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function bytesToB64url(bytes) {
	const b = new Uint8Array(bytes);
	let bin = '';
	for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

/* ---- VAPID ---------------------------------------------------------------- */

function vapidConfig() {
	let subject = (env.VAPID_SUBJECT || '').trim();
	if (subject && !/^(mailto:|https?:)/.test(subject)) {
		subject = subject.includes('@') ? `mailto:${subject}` : `https://${subject}`;
	}
	// $env/dynamic/private excludes PUBLIC_-prefixed vars — the key lives there
	const pub = (publicEnv.PUBLIC_VAPID_PUBLIC_KEY || env.VAPID_PUBLIC_KEY || '').trim();
	const priv = (env.VAPID_PRIVATE_KEY || '').trim();
	if (!pub || !priv) return null; // push not configured — the bell is hidden anyway
	return { subject: subject || 'mailto:admin@localhost', pub, priv };
}

// Importing the signing key costs a keygen-ish operation, and the pair never
// changes at runtime, so hold the CryptoKey rather than re-importing per send.
let _signKey = null;
async function signingKey(pubB64, privB64) {
	if (_signKey) return _signKey;
	// `web-push generate-vapid-keys` emits the raw 32-byte private scalar and the
	// uncompressed public point (0x04 || x || y). WebCrypto wants a JWK, so x and
	// y are carved back out of the public key.
	const pub = b64urlToBytes(pubB64);
	if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key is not an uncompressed P-256 point');
	const jwk = {
		kty: 'EC',
		crv: 'P-256',
		d: bytesToB64url(b64urlToBytes(privB64)),
		x: bytesToB64url(pub.subarray(1, 33)),
		y: bytesToB64url(pub.subarray(33, 65)),
		ext: true
	};
	_signKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
	return _signKey;
}

async function vapidAuthHeader(endpoint, cfg) {
	const key = await signingKey(cfg.pub, cfg.priv);
	const header = bytesToB64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const claims = bytesToB64url(
		utf8(
			JSON.stringify({
				aud: new URL(endpoint).origin,
				exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS,
				sub: cfg.subject
			})
		)
	);
	// WebCrypto ECDSA emits the raw r||s pair, which is exactly what JWS ES256
	// wants — no DER unwrapping needed (that is the usual trap porting off node).
	const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${claims}`));
	return `vapid t=${header}.${claims}.${bytesToB64url(sig)}, k=${cfg.pub}`;
}

/* ---- RFC 8291 payload encryption ------------------------------------------ */

async function hkdf(salt, ikm, info, lengthBytes) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt, info },
		key,
		lengthBytes * 8
	);
	return new Uint8Array(bits);
}

/**
 * `fixed` is for the known-answer test only (see push-check.js) — it pins the
 * salt and ephemeral key so the output can be compared against RFC 8291's
 * published vector. Production never passes it. This exists because a mistake
 * here fails SILENTLY: the push is accepted by the service and simply never
 * displays, which no amount of staring at logs would reveal.
 */
export async function encryptPayload(plaintext, p256dhB64, authB64, fixed) {
	const uaPublic = b64urlToBytes(p256dhB64); // 65-byte uncompressed point
	const authSecret = b64urlToBytes(authB64); // 16 bytes

	const eph = fixed?.keyPair
		? fixed.keyPair
		: await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
	const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256)
	);

	// Order matters and is not symmetric: the info string is the UA's key first,
	// then ours. Swapping them yields a key the browser cannot derive, and the
	// only symptom is a push that silently never displays.
	const prk = await hkdf(authSecret, shared, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
	const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, prk, utf8('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, prk, utf8('Content-Encoding: nonce\0'), 12);

	const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
	// 0x02 is the last-record delimiter. A single record always carries it; 0x01
	// would mean "more records follow" and the browser would wait for them.
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce, tagLength: 128 },
			aesKey,
			concat(plaintext, Uint8Array.of(0x02))
		)
	);

	const rs = new Uint8Array(4);
	new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
	// aes128gcm header: salt(16) || record size(4) || key id length(1) || key id
	return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, ciphertext);
}

/* ---- send ----------------------------------------------------------------- */

async function removeStaleSub(endpoint) {
	try {
		const ids = await adminExecute(DEVICE_MODEL, 'search', [[['endpoint', '=', endpoint]]]);
		if (ids.length) await adminExecute(DEVICE_MODEL, 'unlink', [ids]);
	} catch {
		/* best-effort */
	}
}

export async function sendPush(sub, payload) {
	try {
		const endpoint = sub?.endpoint;
		if (!endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;
		const cfg = vapidConfig();
		if (!cfg) return;

		const body = await encryptPayload(utf8(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: {
				Authorization: await vapidAuthHeader(endpoint, cfg),
				'Content-Encoding': 'aes128gcm',
				'Content-Type': 'application/octet-stream',
				TTL: String(TTL_SECONDS)
			},
			body
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			console.error(
				`[push] send failed: status=${res.status} body=${text.slice(0, 200)} endpoint=${endpoint.slice(0, 40)}`
			);
			// 404/410 mean the subscription is gone for good, not that we failed —
			// drop the row so it stops costing a request on every future notify.
			if (res.status === 404 || res.status === 410) await removeStaleSub(endpoint);
		}
	} catch (err) {
		console.error(`[push] send threw: ${err?.message} endpoint=${String(sub?.endpoint).slice(0, 40)}`);
	}
}

/**
 * Send to all devices registered for a SET of users — two Odoo calls total,
 * however many recipients.
 *
 * The batching is the whole point. Ringing is 1:1 so a per-user helper cost
 * nothing, but a room-wide notify (wave) done one user at a time is 2 sequential
 * Odoo round trips EACH, and Odoo is the scarce resource here — a six-person
 * room would spend twelve calls of a ~1 req/s budget to send six pushes. The
 * pushes themselves go to Apple/Google/Mozilla and are free of that constraint,
 * so they stay parallel and unbatched.
 */
export async function sendToUsers(userIds, payload) {
	const ids = [...new Set(userIds.map(Number).filter(Boolean))];
	if (!ids.length) return;
	const users = await adminExecute('res.users', 'read', [ids], { fields: ['partner_id'] });
	const partnerIds = users.map((u) => u?.partner_id?.[0]).filter(Boolean);
	if (!partnerIds.length) return;
	const rows = await adminExecute(
		DEVICE_MODEL,
		'search_read',
		[[['partner_id', 'in', partnerIds]]],
		{ fields: ['endpoint', 'keys'] }
	);
	await Promise.allSettled(rows.map((r) => sendPush(deviceToSub(r), payload)));
}

/** Send to all devices registered for one user. */
export function sendToUser(userId, payload) {
	return sendToUsers([userId], payload);
}

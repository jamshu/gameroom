import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireUser } from '$lib/server/auth.js';

export const prerender = false;

const STUN_ONLY = [{ urls: 'stun:stun.l.google.com:19302' }];
const TTL = 4 * 3600; // short-lived TURN credentials

/**
 * Reuse a minted credential for an hour of its four-hour life.
 *
 * This endpoint sits directly on the critical path of a voice join — the first
 * RTCPeerConnection cannot be constructed until it answers — and it used to make
 * an external HTTPS round trip to Cloudflare on EVERY join, to mint a credential
 * good for four hours and then throw it away. Rejoining ten seconds later paid
 * the whole cost again.
 *
 * Sharing one credential between callers is safe: generate-ice-servers scopes
 * them to the KEY, not to a user, so a cached response grants nothing a fresh
 * mint wouldn't. requireUser still runs first, so the endpoint stays
 * authenticated.
 *
 * The hour is deliberately a fraction of the TTL, so even the last client served
 * from cache gets three hours of validity. Module scope means this is per-isolate
 * and best-effort — it helps repeated joins and bursts within a session and does
 * nothing on a cold isolate, which is a fine trade for four lines.
 */
const CACHE_MS = 3600_000;
let cached = null; // { iceServers, at }

/**
 * ICE servers for voice. With CF_TURN_KEY_ID + CF_TURN_API_TOKEN set, mints
 * short-lived Cloudflare TURN credentials; otherwise STUN-only (direct-path
 * NATs still work, CGNAT pairs won't).
 */
export async function GET({ cookies }) {
	try {
		await requireUser(cookies);
	} catch (e) {
		return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
	}

	const keyId = env.CF_TURN_KEY_ID;
	const token = env.CF_TURN_API_TOKEN;
	if (!keyId || !token) return json({ ok: true, iceServers: STUN_ONLY, turn: false });

	if (cached && Date.now() - cached.at < CACHE_MS) {
		return json({ ok: true, iceServers: cached.iceServers, turn: true });
	}

	try {
		const res = await fetch(
			`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ ttl: TTL })
			}
		);
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`Cloudflare TURN ${res.status} ${body.slice(0, 160)}`);
		}
		const data = await res.json();
		// two API shapes: {iceServers:[...]} (generate-ice-servers) or
		// {iceServers:{urls,username,credential}} (older generate endpoint)
		const ice = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
		// Cloudflare's own set ONLY — Google's STUN is deliberately not prepended
		// here. Cloudflare already returns STUN (3478 and 53) from the same anycast
		// network as its TURN relays, so its candidates resolve nearer and pair
		// better. Mixing in a second provider just adds candidates to gather, which
		// slows ICE and delays the moment voice actually connects.
		//
		// The list it returns is the whole point of using them: alongside 3478 it
		// offers TURN over 53/udp, 80/tcp and 443/tls — ports that survive
		// restrictive mobile carriers and corporate firewalls where 3478 is
		// blocked outright, which is exactly the case STUN alone cannot rescue.
		cached = { iceServers: ice, at: Date.now() };
		return json({ ok: true, iceServers: ice, turn: true });
	} catch (e) {
		// Deliberately still ok:true with STUN — voice degrades rather than dies.
		// But `turn:false` is the signal that a relay-needing pair WILL fail, so
		// it is logged loudly and returned for the client to surface.
		console.error('TURN credential mint failed:', e.message);
		return json({ ok: true, iceServers: STUN_ONLY, turn: false });
	}
}

import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireUser } from '$lib/server/auth.js';

export const prerender = false;

const STUN_ONLY = [{ urls: 'stun:stun.l.google.com:19302' }];
const TTL = 4 * 3600; // short-lived TURN credentials

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
		return json({ ok: true, iceServers: ice, turn: true });
	} catch (e) {
		// Deliberately still ok:true with STUN — voice degrades rather than dies.
		// But `turn:false` is the signal that a relay-needing pair WILL fail, so
		// it is logged loudly and returned for the client to surface.
		console.error('TURN credential mint failed:', e.message);
		return json({ ok: true, iceServers: STUN_ONLY, turn: false });
	}
}

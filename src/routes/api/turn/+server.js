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
		if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
		const data = await res.json();
		// two API shapes: {iceServers:[...]} (generate-ice-servers) or
		// {iceServers:{urls,username,credential}} (older generate endpoint)
		const ice = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
		return json({ ok: true, iceServers: [...STUN_ONLY, ...ice], turn: true });
	} catch (e) {
		console.error('TURN credential mint failed:', e.message);
		return json({ ok: true, iceServers: STUN_ONLY, turn: false });
	}
}

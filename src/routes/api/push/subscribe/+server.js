// Save/remove a device push subscription. Single source of truth is Odoo's
// native mail.push.device (partner-keyed), written with the admin key and
// upserted by endpoint — endpoints are unique per browser/device subscription.
// Odoo-originated notifications push to the same rows.
//
// Odoo must sign pushes with the same VAPID key pair the browser subscribed
// under, so we claim Odoo's (unset) VAPID config params with the app's keys
// once and never overwrite them.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { requireUser } from '$lib/server/auth.js';
import { adminExecute } from '$lib/server/odoo.js';

export const prerender = false;

// python's base64.urlsafe_b64decode requires padding; npm web-push keys have none
const b64pad = (s) => s + '='.repeat((4 - (s.length % 4)) % 4);

let _vapidClaimed = false;
async function claimOdooVapid() {
	if (_vapidClaimed) return;
	// $env/dynamic/private excludes PUBLIC_-prefixed vars — the key lives there
	const pub = (publicEnv.PUBLIC_VAPID_PUBLIC_KEY || env.VAPID_PUBLIC_KEY || '').trim();
	const priv = (env.VAPID_PRIVATE_KEY || '').trim();
	if (!pub || !priv) return; // keys not configured — retry next call, don't cache
	const existing = await adminExecute('ir.config_parameter', 'search', [
		[['key', 'in', ['mail.web_push_vapid_public_key', 'mail.web_push_vapid_private_key']]]
	]);
	// never overwrite — if Odoo already has keys, existing Odoo-side
	// subscriptions depend on them
	if (!existing.length) {
		await adminExecute('ir.config_parameter', 'set_param', [
			'mail.web_push_vapid_public_key', b64pad(pub)
		]);
		await adminExecute('ir.config_parameter', 'set_param', [
			'mail.web_push_vapid_private_key', b64pad(priv)
		]);
	}
	_vapidClaimed = true;
}

export async function POST({ request, cookies }) {
	try {
		const { uid } = await requireUser(cookies);
		const { endpoint, keys } = (await request.json()) ?? {};
		if (!endpoint || !keys?.p256dh || !keys?.auth) {
			return json({ ok: false, error: 'Invalid subscription data' }, { status: 400 });
		}
		await claimOdooVapid();
		const [u] = await adminExecute('res.users', 'read', [[uid]], { fields: ['partner_id'] });
		const partnerId = u?.partner_id?.[0];
		if (!partnerId) return json({ ok: false, error: 'No partner for user' }, { status: 500 });
		const existing = await adminExecute('mail.push.device', 'search', [
			[['endpoint', '=', endpoint]]
		]);
		if (existing.length) await adminExecute('mail.push.device', 'unlink', [existing]);
		await adminExecute('mail.push.device', 'create', [{
			partner_id: partnerId,
			endpoint,
			keys: JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth })
		}]);
		return json({ ok: true });
	} catch (e) {
		console.error('[push/subscribe] POST failed:', e?.message);
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}

export async function DELETE({ request, cookies }) {
	try {
		await requireUser(cookies);
		const { endpoint } = (await request.json()) ?? {};
		if (!endpoint) return json({ ok: false, error: 'endpoint required' }, { status: 400 });
		const ids = await adminExecute('mail.push.device', 'search', [
			[['endpoint', '=', endpoint]]
		]);
		if (ids.length) await adminExecute('mail.push.device', 'unlink', [ids]);
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}

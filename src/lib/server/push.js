// Web push (VAPID) via Odoo's native mail.push.device. Subscriptions are
// partner-keyed; `keys` is a JSON string {p256dh, auth}. Odoo pushes to the same
// rows for its own notifications, so it must sign with the same VAPID pair.
import webpush from 'web-push';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { adminExecute } from './odoo.js';

const DEVICE_MODEL = 'mail.push.device';

const deviceToSub = (d) => {
	let keys = {};
	try {
		keys = JSON.parse(d.keys || '{}');
	} catch {
		/* malformed row — web push will fail and clean it up */
	}
	return { endpoint: d.endpoint, keys };
};

let vapidSet = false;
function ensureVapid() {
	if (vapidSet) return;
	let subject = (env.VAPID_SUBJECT || '').trim();
	if (subject && !/^(mailto:|https?:)/.test(subject)) {
		subject = subject.includes('@') ? `mailto:${subject}` : `https://${subject}`;
	}
	// $env/dynamic/private excludes PUBLIC_-prefixed vars — the key lives there
	const pub = (publicEnv.PUBLIC_VAPID_PUBLIC_KEY || env.VAPID_PUBLIC_KEY || '').trim();
	const priv = (env.VAPID_PRIVATE_KEY || '').trim();
	webpush.setVapidDetails(subject, pub, priv);
	vapidSet = true;
}

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
		ensureVapid();
		await webpush.sendNotification(sub, JSON.stringify(payload));
	} catch (err) {
		console.error(
			`[push] sendNotification failed: status=${err.statusCode} body=${err.body} msg=${err.message} endpoint=${sub.endpoint?.slice(0, 40)}`
		);
		if (err.statusCode === 404 || err.statusCode === 410) {
			await removeStaleSub(sub.endpoint);
		}
	}
}

/** Send to all devices registered for one user. */
export async function sendToUser(userId, payload) {
	const [u] = await adminExecute('res.users', 'read', [[userId]], { fields: ['partner_id'] });
	const partnerId = u?.partner_id?.[0];
	if (!partnerId) return;
	const rows = await adminExecute(
		DEVICE_MODEL,
		'search_read',
		[[['partner_id', '=', partnerId]]],
		{ fields: ['endpoint', 'keys'] }
	);
	await Promise.allSettled(rows.map((r) => sendPush(deviceToSub(r), payload)));
}

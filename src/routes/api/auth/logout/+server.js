import { json } from '@sveltejs/kit';
import { destroySession } from '$lib/server/odoo.js';
import {
	getSession,
	clearSessionCookie,
	clearContextCookie,
	clearUserCookie
} from '$lib/server/session.js';

export const prerender = false;

export async function POST({ cookies }) {
	const sid = getSession(cookies);
	if (sid) await destroySession(sid).catch(() => {});
	clearSessionCookie(cookies);
	clearContextCookie(cookies);
	// identity now outlives the Odoo session, so signing out must drop it too
	clearUserCookie(cookies);
	return json({ ok: true });
}

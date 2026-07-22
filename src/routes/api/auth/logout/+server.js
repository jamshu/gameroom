import { json } from '@sveltejs/kit';
import { destroySession } from '$lib/server/odoo.js';
import { getSession, clearSessionCookie, clearContextCookie } from '$lib/server/session.js';

export const prerender = false;

export async function POST({ cookies }) {
	const sid = getSession(cookies);
	if (sid) await destroySession(sid);
	clearSessionCookie(cookies);
	clearContextCookie(cookies);
	return json({ ok: true });
}

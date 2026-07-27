import { test, expect } from '@playwright/test';

/**
 * Following another user from the lobby. The button is visible to everyone (not
 * host-only), never appears on your own row, and reflects the server's follow
 * list on load.
 */

const ME = { uid: 100, name: 'Host' };
const room = (over = {}) => ({
	id: 1, name: 'Follow Test', gameType: 'chess', status: 'lobby',
	hostUid: 100, hostName: 'Host', maxPlayers: 8, drawsTotal: 0, ...over
});
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Host', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Bee', status: 'accepted', role: 'player', score: 0, online: true }
];
const STATE = { v: 1, voice: [], game: null };

async function mockBackend(page, { following = [] } = {}) {
	const r = room();
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (x) => x.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: r, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({ json: { ok: true, cursor: 0, events: [], room: r, members: MEMBERS, state: STATE } })
	);
	await page.route('**/api/follow', (x) => {
		if (x.request().method() === 'GET') return x.fulfill({ json: { ok: true, following } });
		return x.fulfill({ json: { ok: true } });
	});
}

test('follow button toggles and never shows on my own row', async ({ page }) => {
	await mockBackend(page);
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();

	const myRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Host$/ }) });
	const beeRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Bee$/ }) });

	// no follow button against myself
	await expect(myRow.getByRole('button', { name: /Follow/ })).toHaveCount(0);

	// Bee's row starts as "+ Follow" and flips optimistically on click
	const btn = beeRow.getByRole('button', { name: /Follow/ });
	await expect(btn).toHaveText('+ Follow');
	let sent = null;
	await page.route('**/api/follow', (x) => {
		sent = x.request().postDataJSON();
		x.fulfill({ json: { ok: true } });
	});
	await btn.click();
	await expect(btn).toHaveText('✓ Following');
	expect(sent).toEqual({ targetUid: 101, action: 'follow' });
});

test('an already-followed user shows as Following on load', async ({ page }) => {
	await mockBackend(page, { following: [101] });
	await page.goto('/room/1');
	const beeRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Bee$/ }) });
	await expect(beeRow.getByRole('button', { name: /Following/ })).toHaveText('✓ Following');
});

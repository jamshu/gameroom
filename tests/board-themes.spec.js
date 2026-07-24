import { test, expect } from '@playwright/test';

/**
 * Colour themes on the ludo and carrom boards, mirroring the chess theme case in
 * chess-fullscreen.spec.js. The one that really matters is fullscreen: the ludo
 * play area is portalled to <body>, so a theme applied only to the card would
 * silently revert the moment the board goes fullscreen.
 */

const ME = { uid: 100, name: 'Red' };
const room = (gameType) => ({
	id: 1, name: 'Theme Test', gameType, status: 'playing',
	hostUid: 100, hostName: 'Red', maxPlayers: 4, drawsTotal: 0
});
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Red', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Yellow', status: 'accepted', role: 'player', score: 0, online: true }
];

const LUDO = {
	type: 'ludo', players: [100, 101], colors: { 100: 'red', 101: 'yellow' },
	turnIdx: 0, dice: null, rolled: false, sixStreak: 0,
	tokens: { 100: [-1, -1, -1, -1], 101: [-1, -1, -1, -1] },
	lastEvent: null, finished: [], result: null
};

const CARROMS = {
	type: 'carroms', players: [100, 101], turnIdx: 0,
	pieces: [
		{ id: 'q', color: 'q', x: 500, y: 500, pocketed: false },
		{ id: 'p0', color: 'w', x: 560, y: 500, pocketed: false },
		{ id: 'p1', color: 'b', x: 440, y: 500, pocketed: false }
	],
	queenPocketedBy: null, coverPending: false, scores: { w: 0, b: 0 },
	lastEvent: null, result: null
};

async function mockBackend(page, gameType, game) {
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (r) => r.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: room(gameType), members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({
			json: {
				ok: true, cursor: 0, events: [], room: room(gameType), members: MEMBERS,
				state: { v: 1, voice: [], game }
			}
		})
	);
}

test('ludo colours can be switched, survive fullscreen, and persist', async ({ page }) => {
	await mockBackend(page, 'ludo', LUDO);
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	await page.getByRole('button', { name: 'Board colours' }).click();
	await expect(page.locator('.themes')).toBeVisible();
	await expect(page.locator('.themes .sw')).toHaveCount(4);

	await page.getByRole('button', { name: 'Accessible' }).click();
	// the four names are re-mapped as CSS custom properties
	const playStyle = await page.locator('.play-area').getAttribute('style');
	console.log('play-area style after Accessible:', playStyle);
	expect(playStyle).toContain('#d55e00'); // red → vermillion
	expect(playStyle).toContain('#0072b2'); // blue

	// THE case this design exists for: `portal` moves .play-area to <body> in
	// fullscreen, so anything inherited from the card is lost.
	await page.getByRole('button', { name: /Fullscreen/ }).click();
	await expect(page.locator('.play-area--fs')).toBeVisible();
	expect(await page.locator('.play-area').evaluate((el) => el.parentElement.tagName)).toBe('BODY');
	expect(await page.locator('.play-area').getAttribute('style')).toContain('#d55e00');
	await page.screenshot({ path: 'test-results/ludo-theme-accessible-fs.png' });
	await page.keyboard.press('Escape');

	// choice survives a reload (localStorage)
	await page.reload();
	await expect(page.locator('.board')).toBeVisible();
	expect(await page.locator('.play-area').getAttribute('style')).toContain('#d55e00');
});

test('carrom board themes switch and persist', async ({ page }) => {
	await mockBackend(page, 'carroms', CARROMS);
	await page.goto('/room/1');
	const canvas = page.locator('.carrom-canvas');
	await expect(canvas).toBeVisible();

	// the canvas has no DOM to assert, so read the felt pixel back out of it
	const feltAt = () =>
		canvas.evaluate((c) => {
			const d = c.getContext('2d').getImageData(500, 300, 1, 1).data;
			return `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
		});

	expect(await feltAt()).toBe('#e9d3a3'); // Maple, the historical default

	await page.getByRole('button', { name: '🎨' }).click();
	await expect(page.locator('.themes .sw')).toHaveCount(4);
	await page.getByRole('button', { name: 'Slate' }).click();
	expect(await feltAt()).toBe('#cfd6dd');
	await page.screenshot({ path: 'test-results/carrom-theme-slate.png' });

	await page.reload();
	await expect(canvas).toBeVisible();
	expect(await feltAt()).toBe('#cfd6dd');
});

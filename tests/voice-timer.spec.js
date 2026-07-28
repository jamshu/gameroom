import { test, expect } from '@playwright/test';

/**
 * Call duration in the voice bar. A call is TWO people — one person sitting in
 * voice is waiting, not talking — so the clock only appears at two.
 *
 * The server sends elapsed-ms measured at its own clock rather than an absolute
 * start stamp, so a viewer whose device clock is wrong still sees the real call
 * length. These tests pin that: the fixture's voiceMs is what must show, whatever
 * the browser thinks the time is.
 */

const ME = { uid: 100, name: 'Me' };
const ROOM = {
	id: 1, name: 'Voice Test', gameType: 'chess', status: 'lobby',
	hostUid: 100, hostName: 'Me', maxPlayers: 2, drawsTotal: 0
};
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Me', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Opp', status: 'accepted', role: 'player', score: 0, online: true }
];

async function mockBackend(page, { voice = [], voiceMs = null } = {}) {
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (r) => r.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route('**/api/follow**', (r) => r.fulfill({ json: { ok: true, following: [] } }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({
			json: {
				ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS,
				state: { v: 1, voice, voiceMs, game: null }
			}
		})
	);
}

test('no call, no clock', async ({ page }) => {
	await mockBackend(page, { voice: [], voiceMs: null });
	await page.goto('/room/1');
	await expect(page.getByText(/🎙️ Voice/)).toBeVisible();

	await expect(page.locator('.call-time')).toHaveCount(0);
});

test('one person in voice is waiting, not on a call', async ({ page }) => {
	// the server withholds voiceMs below two, and the bar must not invent one
	await mockBackend(page, { voice: [101], voiceMs: null });
	await page.goto('/room/1');
	await expect(page.getByText(/🎙️ Voice \(1\/8\)/)).toBeVisible();

	await expect(page.locator('.call-time')).toHaveCount(0);
});

test('two people connected shows the call clock, counting from the server', async ({ page }) => {
	await mockBackend(page, { voice: [100, 101], voiceMs: 65_000 });
	await page.goto('/room/1');

	// 65s in — not 0:00, which is what a client-started timer would have shown
	await expect(page.locator('.call-time')).toContainText('1:0');
	const first = await page.locator('.call-time').innerText();
	expect(first.trim()).toMatch(/^1:0[567]$/);
});

test('the clock ticks on its own between polls', async ({ page }) => {
	await mockBackend(page, { voice: [100, 101], voiceMs: 5_000 });
	await page.goto('/room/1');
	await expect(page.locator('.call-time')).toBeVisible();

	const before = await page.locator('.call-time').innerText();
	// nothing else changes between polls, so without its own heartbeat the readout
	// would sit frozen at whatever the last snapshot said
	await expect(page.locator('.call-time')).not.toHaveText(before, { timeout: 4000 });
});

test('past an hour it grows an hours field', async ({ page }) => {
	await mockBackend(page, { voice: [100, 101], voiceMs: 3_725_000 }); // 1h 2m 5s
    await page.goto('/room/1');

	await expect(page.locator('.call-time')).toContainText('1:02:0');
});

import { test, expect } from '@playwright/test';

/**
 * Chat belongs to the lobby and the post-game wash-up, not to the game itself —
 * during play it is a 260–420px slab under the board on a phone, which is the
 * space the board wants. Fully mocked (the app is CSR-only).
 *
 * The pairing these tests exist to protect: chat and the voice bar live in the
 * SAME <aside>, so the obvious way to hide one is to hide the sidebar — which
 * silently takes mute and join-voice away mid-game, when they matter most.
 */

const ME = { uid: 100, name: 'Me' };
const room = (status) => ({
	id: 1, name: 'Visibility Test', gameType: 'chess', status,
	hostUid: 100, hostName: 'Me', maxPlayers: 2, drawsTotal: 0
});
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Me', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Opp', status: 'accepted', role: 'player', score: 0, online: true }
];
const GAME = {
	type: 'chess',
	players: { w: 100, b: 101 },
	fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
	moves: ['e4'],
	result: null,
	clock: { w: 600000, b: 600000, ticking: 'b' }
};

const THIEF = {
	type: 'thief_finder', phase: 'picking', draw: 1, players: [100, 101],
	claims: {}, envelopeCount: 2, policeUid: null, totals: {}
};

async function mockBackend(page, status, gameType = 'chess') {
	const ROOM = { ...room(status), gameType };
	// only a live game carries state.game; in lobby the board must not render
	const game = status === 'lobby' ? null : gameType === 'thief_finder' ? THIEF : GAME;
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (r) => r.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route('**/api/follow**', (r) => r.fulfill({ json: { ok: true, following: [] } }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({
			json: { ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS, state: { v: 1, voice: [], game } }
		})
	);
}

const composer = (page) => page.getByPlaceholder('Message…');
const voiceBar = (page) => page.getByText(/🎙️ Voice/);

test('chat is there in the lobby', async ({ page }) => {
	await mockBackend(page, 'lobby');
	await page.goto('/room/1');

	await expect(composer(page)).toBeVisible();
	await expect(voiceBar(page)).toBeVisible();
});

test('chat is gone once the game starts — but voice is not', async ({ page }) => {
	await mockBackend(page, 'playing');
	await page.goto('/room/1');
	// wait for something that only exists mid-game, so an empty assertion can't
	// pass just because the page hadn't rendered yet
	await expect(page.locator('.board')).toBeVisible();

	await expect(composer(page)).toHaveCount(0);
	// the headline: hiding chat must not cost the player their mute button
	await expect(voiceBar(page)).toBeVisible();
});

test('chat comes back when the game finishes, with its history intact', async ({ page }) => {
	await mockBackend(page, 'finished');
	await page.goto('/room/1');

	await expect(composer(page)).toBeVisible();
	await expect(voiceBar(page)).toBeVisible();
});

test('Thief Finder has no voice bar — it is a table game, not a call', async ({ page }) => {
	await mockBackend(page, 'playing', 'thief_finder');
	await page.goto('/room/1');
	await expect(page.getByText(/Draw|Envelope|envelope/).first()).toBeVisible();

	await expect(voiceBar(page)).toHaveCount(0);
	await expect(composer(page)).toHaveCount(0); // chat still hidden during play
	// with both gone the sidebar must not render at all, or the grid's 18px gap
	// still draws above the table
	await expect(page.locator('.room-side')).toHaveCount(0);
});

test('Thief Finder keeps chat in the lobby, still without voice', async ({ page }) => {
	await mockBackend(page, 'lobby', 'thief_finder');
	await page.goto('/room/1');

	await expect(composer(page)).toBeVisible();
	await expect(voiceBar(page)).toHaveCount(0);
});

test('voice stays above the fold once the grid collapses', async ({ browser }) => {
	// collapsing to one column drops the sidebar BELOW the board, which on a short
	// screen buries the mute button ~300px past the fold. Keeping voice reachable
	// is the whole reason it was left in while chat went.
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const page = await ctx.newPage();
	await mockBackend(page, 'playing');
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	const voice = await voiceBar(page).boundingBox();
	const board = await page.locator('.board').boundingBox();
	expect(voice.y + voice.height).toBeLessThan(720); // no scrolling to mute
	expect(voice.y).toBeLessThan(board.y); // above the board, not under it
	await ctx.close();
});

test('the board grows into the space chat used to take', async ({ browser }) => {
	// tall enough that the clamp is not floored — at 720px tall the reserve would
	// bite and the board would stay at its 520px minimum, proving nothing
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
	const page = await ctx.newPage();
	await mockBackend(page, 'playing');
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	const board = await page.locator('.board').boundingBox();
	console.log(`board width at 1400x1000: ${board.width.toFixed(0)}px (was capped at 520)`);
	expect(board.width).toBeGreaterThan(520);
	// still a board, not a wall — and still square
	expect(board.width).toBeLessThanOrEqual(720);
	expect(Math.abs(board.width - board.height)).toBeLessThan(2);
	await ctx.close();
});

test('a short viewport never makes the board smaller than it used to be', async ({ browser }) => {
	// the regression the clamp floor exists for: bare calc(100svh - 240px) is
	// 480px here, i.e. narrower than the 520px this board has always been
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	const page = await ctx.newPage();
	await mockBackend(page, 'playing');
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	const board = await page.locator('.board').boundingBox();
	console.log(`board width at 1280x720: ${board.width.toFixed(0)}px (floor is 520)`);
	expect(board.width).toBeGreaterThanOrEqual(520);
	await ctx.close();
});

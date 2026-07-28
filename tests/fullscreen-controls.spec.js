import { test, expect, devices } from '@playwright/test';

/**
 * Fullscreen used to be a dead end: the overlay portals ONE element to <body> and
 * covers the card, so everything outside that element vanished. Chess lost move
 * review, Resign, Offer draw and the draw response; Ludo lost the player strip.
 *
 * The load-bearing assertion in here is the toHaveCount(1) pair. The card stays in
 * the DOM behind the overlay, so a copy-paste implementation leaves a second Resign
 * button that is invisible but still keyboard-reachable. Rendering each block in
 * exactly one place is what these guard.
 */

test.use({ ...devices['Pixel 5'] });

const ME = { uid: 100, name: 'Me' };
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Me', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Opp', status: 'accepted', role: 'player', score: 0, online: true }
];
const room = (gameType) => ({
	id: 1, name: 'FS Test', gameType, status: 'playing',
	hostUid: 100, hostName: 'Me', maxPlayers: 4, drawsTotal: 0
});

const CHESS = {
	type: 'chess',
	players: { w: 100, b: 101 },
	fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
	moves: ['e4'],
	result: null,
	drawOffer: null,
	clock: { w: 600000, b: 600000, ticking: 'b' }
};
const LUDO = {
	type: 'ludo',
	players: [100, 101],
	colors: { 100: 'red', 101: 'green' },
	turnIdx: 0,
	dice: null,
	rolled: false,
	sixStreak: 0,
	tokens: { 100: [-1, -1, -1, -1], 101: [-1, -1, -1, -1] },
	lastEvent: null,
	finished: [],
	result: null
};

async function mockBackend(page, gameType, gameOverrides = {}) {
	const ROOM = room(gameType);
	const base = gameType === 'ludo' ? LUDO : CHESS;
	const game = { ...base, ...gameOverrides };
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (r) => r.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({
			json: { ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS, state: { v: 1, voice: [], game } }
		})
	);
}

async function enterFullscreen(page, overlay) {
	await page.getByTitle('Fullscreen board').click({ force: true });
	await expect(page.locator(overlay)).toBeVisible();
	// portalled out of the transformed .room ancestor, or position:fixed mis-anchors
	expect(await page.locator(overlay).evaluate((el) => el.parentElement.tagName)).toBe('BODY');
}

/* ---- chess ------------------------------------------------------------- */

test('chess fullscreen carries review, Resign and Offer draw — one copy each', async ({ page }) => {
	await mockBackend(page, 'chess');
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await enterFullscreen(page, '.board-wrap--fs');

	for (const title of ['First move', 'Previous move', 'Next move', 'Back to live']) {
		await expect(page.getByTitle(title)).toBeVisible();
	}
	await expect(page.getByRole('button', { name: /Resign/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /Offer draw/ })).toBeVisible();

	// the headline: rendered in the overlay INSTEAD of the card, never as well as
	await expect(page.getByTitle('Previous move')).toHaveCount(1);
	await expect(page.getByRole('button', { name: /Resign/ })).toHaveCount(1);
	await expect(page.locator('.review')).toHaveCount(1);
});

test('stepping back and returning to live works without leaving fullscreen', async ({ page }) => {
	await mockBackend(page, 'chess');
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await enterFullscreen(page, '.board-wrap--fs');

	await expect(page.locator('.review-pos')).toHaveText('live');
	await page.getByTitle('Previous move').click({ force: true });
	await expect(page.locator('.review-pos')).toHaveText('move 0/1');
	// myTurn is gated on reviewPly === null, so without this the board is unplayable
	await page.getByTitle('Back to live').click({ force: true });
	await expect(page.locator('.review-pos')).toHaveText('live');
});

test('a draw offer can be answered from inside fullscreen', async ({ page }) => {
	// offered BY the opponent, so I get Accept/Decline rather than "waiting…"
	await mockBackend(page, 'chess', { drawOffer: 101 });
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await enterFullscreen(page, '.board-wrap--fs');

	await expect(page.locator('.draw-offer')).toContainText('Opp offers a draw');
	await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Decline' })).toHaveCount(1);
});

test('a finished game shows its result in fullscreen instead of just freezing', async ({ page }) => {
	// result is a COLOUR ('w' | 'b' | 'draw'), not a score line — resultText maps it
	// through game.players to a name
	await mockBackend(page, 'chess', { result: 'b', endReason: 'resign' });
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await enterFullscreen(page, '.board-wrap--fs');

	await expect(page.locator('.board-wrap--fs .fs-status')).toContainText('Opp wins by resignation');
	// resigned games have no match actions left to offer
	await expect(page.getByRole('button', { name: /Resign/ })).toHaveCount(0);
});

/**
 * The buttons must never touch the pieces.
 *
 * A tall phone cannot catch this: there the board is WIDTH-bound with ~200px spare
 * above and below, so everything clears no matter how the space is divided. The bug
 * only appears once the board is HEIGHT-bound and the reserve is what positions it —
 * so these run at sizes where height is the smaller term. The first two are the
 * shapes that were overlapping by 12px and 22px respectively.
 */
for (const [w, h] of [
	[900, 700],
	[400, 500],
	[1280, 720],
	[851, 393],
	[1440, 900]
]) {
	test(`controls clear the board at ${w}x${h}`, async ({ browser }) => {
		const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
		const page = await ctx.newPage();
		await mockBackend(page, 'chess');
		await page.goto('/room/1');
		await expect(page.locator('.board')).toBeVisible();
		await enterFullscreen(page, '.board-wrap--fs');

		const board = await page.locator('.board-wrap--fs .board').boundingBox();
		const controls = await page.locator('.fs-controls').boundingBox();
		const status = await page.locator('.fs-status').boundingBox();
		const below = controls.y - (board.y + board.height);
		const above = board.y - (status.y + status.height);
		console.log(`${w}x${h}: board=${board.width.toFixed(0)} above=${above.toFixed(0)} below=${below.toFixed(0)}`);

		expect(below).toBeGreaterThan(0); // buttons off the bottom rank
		expect(above).toBeGreaterThan(0); // status off the top rank
		// still wholly on screen — lifting the board must not push it off an edge
		expect(board.y).toBeGreaterThanOrEqual(0);
		expect(board.y + board.height).toBeLessThanOrEqual(h);
		// and lifted, not centred: the bottom band carries a row the top does not
		expect(h - (board.y + board.height)).toBeGreaterThan(board.y);
		await ctx.close();
	});
}

/* ---- ludo -------------------------------------------------------------- */

test('ludo fullscreen carries the player strip — one copy, turn ring intact', async ({ page }) => {
	await mockBackend(page, 'ludo');
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await enterFullscreen(page, '.play-area--fs');

	await expect(page.locator('.play-area--fs .pl')).toHaveCount(2);
	await expect(page.locator('.pl')).toHaveCount(2); // not duplicated behind the overlay
	await expect(page.locator('.play-area--fs .players')).toContainText('Me (you)');
	await expect(page.locator('.play-area--fs .players')).toContainText('Opp');

	// turnIdx 0 → players[0] === 100 === me is to move
	await expect(page.locator('.play-area--fs .pl--now')).toHaveCount(1);
	await expect(page.locator('.play-area--fs .pl--now')).toContainText('Me');
});

test('the ludo player strip sits above the board and does not cover it', async ({ page }) => {
	await mockBackend(page, 'ludo');
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await enterFullscreen(page, '.play-area--fs');

	const strip = await page.locator('.play-area--fs .players').boundingBox();
	const board = await page.locator('.play-area--fs .board').boundingBox();
	console.log(`strip bottom=${(strip.y + strip.height).toFixed(0)} board top=${board.y.toFixed(0)}`);
	expect(strip.y + strip.height).toBeLessThanOrEqual(board.y + 1);
	expect(board.y + board.height).toBeLessThanOrEqual(page.viewportSize().height);
});

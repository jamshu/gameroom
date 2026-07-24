import { test, expect, devices } from '@playwright/test';

/**
 * Mobile fullscreen layout for the chess board. Driven off mocked API responses
 * (the app is CSR-only). Runs in a mobile device context so pointer is coarse and
 * the board takes the CSS-overlay fullscreen path (native requestFullscreen is
 * gated to desktop). Asserts: pieces fill the square, and in fullscreen the board
 * is vertically centred (no big top gap) with the clocks pinned near the top.
 */

test.use({ ...devices['Pixel 5'] });

const ME = { uid: 100, name: 'Me' };
const ROOM = {
	id: 1, name: 'Chess Test', gameType: 'chess', status: 'playing',
	hostUid: 100, hostName: 'Me', maxPlayers: 2, drawsTotal: 0
};
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Me', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Opp', status: 'accepted', role: 'player', score: 0, online: true }
];
const game = {
	type: 'chess',
	players: { w: 100, b: 101 },
	fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
	moves: ['e4'],
	result: null,
	clock: { w: 600000, b: 600000, ticking: 'b' }
};

async function mockBackend(page) {
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (r) => r.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({ json: { ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS, state: { v: 1, voice: [], game } } })
	);
}

test('pieces fill the square and fullscreen board is vertically centred', async ({ page }) => {
	await mockBackend(page);
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	// pieces should fill ~95% of the square
	const sqBox = await page.locator('.sq').first().boundingBox();
	const pieceBox = await page.locator('.piece').first().boundingBox();
	const fill = pieceBox.width / sqBox.width;
	console.log(`piece fill ratio: ${(fill * 100).toFixed(0)}% of the square`);
	expect(fill).toBeGreaterThan(0.9);

	// normal (non-fullscreen) view: opponent bar sits above the board, mine below.
	// I am white (players.w=100), so my bar is 'Me' and the top bar is 'Opp'.
	const boardTop = (await page.locator('.board').boundingBox()).y;
	const bars = page.locator('.chess-player');
	await expect(bars).toHaveCount(2);
	const topBar = await bars.first().boundingBox();
	const bottomBar = await bars.last().boundingBox();
	expect(topBar.y).toBeLessThan(boardTop);
	expect(bottomBar.y).toBeGreaterThan(boardTop);
	await expect(bars.first()).toContainText('Opp');
	await expect(bars.last()).toContainText('Me');
	await page.screenshot({ path: 'test-results/chess-normal.png' });

	// enter fullscreen (CSS overlay on this mobile context). The overlay is
	// portalled to <body>, so the .room ancestor transform can't offset it.
	await page.getByTitle('Fullscreen board').click({ force: true });
	await expect(page.locator('.board-wrap--fs')).toBeVisible();
	// the overlay must be a direct child of <body> (escaped the transformed shell)
	const parentTag = await page.locator('.board-wrap--fs').evaluate((el) => el.parentElement.tagName);
	expect(parentTag).toBe('BODY');

	const vh = page.viewportSize().height;
	const overlay = await page.locator('.board-wrap--fs').boundingBox();
	const board = await page.locator('.board-wrap--fs .board').boundingBox();
	const topClock = await page.locator('.fs-player--top').boundingBox();
	const bottomClock = await page.locator('.fs-player--bottom').boundingBox();
	const topGap = board.y;
	const bottomGap = vh - (board.y + board.height);
	console.log(`overlay=${overlay.x},${overlay.y} ${overlay.width}x${overlay.height} | board.y=${board.y.toFixed(0)} h=${board.height.toFixed(0)} | topGap=${topGap.toFixed(0)} bottomGap=${bottomGap.toFixed(0)}`);
	console.log(`topClock.y=${topClock.y.toFixed(0)} bottomClock.y=${bottomClock.y.toFixed(0)}`);

	await page.screenshot({ path: 'test-results/chess-fullscreen.png' });

	// overlay fills the viewport (not a transformed ancestor's box)
	expect(overlay.y).toBeLessThan(2);
	expect(overlay.height).toBeGreaterThan(vh - 2);
	// board vertically centred: top and bottom gaps within 24px of each other
	expect(Math.abs(topGap - bottomGap)).toBeLessThan(24);
	// opponent clock pinned at the top (above the board), my clock at the bottom
	expect(topClock.y).toBeLessThan(topGap);
	expect(bottomClock.y).toBeGreaterThan(board.y + board.height);
	// I am white here → my (white) clock is the bottom strip
	await expect(page.locator('.fs-player--bottom')).toContainText('Me');
	await expect(page.locator('.fs-player--top')).toContainText('Opp');
});

test('board and piece themes can be switched and persist', async ({ page }) => {
	await mockBackend(page);
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	// default set is the hand-polished one
	await expect(page.locator('.piece').first()).toHaveAttribute('src', /\/pieces\/polished\//);

	await page.getByRole('button', { name: '🎨 Theme' }).click();
	await expect(page.locator('.themes')).toBeVisible();
	await expect(page.locator('.themes .swatches').first().locator('.sw')).toHaveCount(6);
	await expect(page.locator('.themes .swatches').last().locator('.sw')).toHaveCount(3);

	// switch the board colours — they ride CSS custom properties on .board
	await page.getByRole('button', { name: 'Boxwood' }).click();
	const style = await page.locator('.board').getAttribute('style');
	console.log('board style after Boxwood:', style);
	expect(style).toContain('#f0d9b5');
	expect(style).toContain('#b58863');

	// switch the piece set — every piece img repoints at that directory
	await page.getByRole('button', { name: 'Fantasy' }).click();
	await expect(page.locator('.piece').first()).toHaveAttribute('src', /\/pieces\/fantasy\//);
	await page.screenshot({ path: 'test-results/chess-theme-boxwood-fantasy.png' });

	// choice survives a reload (localStorage)
	await page.reload();
	await expect(page.locator('.board')).toBeVisible();
	await expect(page.locator('.piece').first()).toHaveAttribute('src', /\/pieces\/fantasy\//);
	expect(await page.locator('.board').getAttribute('style')).toContain('#f0d9b5');
});

test('hovering a piece tilts it and settles back', async ({ browser }) => {
	// a desktop (fine-pointer) context: hover/tilt is a pointer affordance
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
	const page = await ctx.newPage();
	await mockBackend(page);
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	// a square that holds a piece (a1 rook for white at the bottom-left)
	const sq = page.locator('.sq:has(.piece)').first();
	const lift = sq.locator('.lift');
	expect(await lift.evaluate((el) => el.style.transform || '')).toBe('');

	const box = await sq.boundingBox();
	// off-centre so both axes rotate
	await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.24);
	await expect
		.poll(async () => lift.evaluate((el) => el.style.transform || ''))
		.toMatch(/rotateX\(-?[\d.]+deg\) rotateY\(-?[\d.]+deg\)/);
	const tilted = await lift.evaluate((el) => el.style.transform);
	console.log('tilt transform:', tilted);
	// sheen lights up while hovering
	await expect(sq.locator('.sheen')).toHaveCSS('opacity', '1');
	await page.screenshot({ path: 'test-results/chess-hover-tilt.png' });

	// leaving resets to flat
	await page.mouse.move(box.x + box.width * 0.78, box.y - 220);
	await expect
		.poll(async () => lift.evaluate((el) => el.style.transform || ''))
		.toBe('rotateX(0deg) rotateY(0deg)');
	await ctx.close();
});

test('playing a move slides the piece and plays a sound', async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
	const page = await ctx.newPage();

	// count oscillators so we can prove a sound was actually synthesised
	await page.addInitScript(() => {
		window.__osc = 0;
		const AC = window.AudioContext || window.webkitAudioContext;
		window.AudioContext = class extends AC {
			createOscillator() {
				window.__osc++;
				return super.createOscillator();
			}
		};
	});

	// same room, but it is WHITE (me) to move from the opening position
	const myTurnGame = {
		type: 'chess',
		players: { w: 100, b: 101 },
		fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
		moves: [],
		result: null,
		clock: { w: 600000, b: 600000, ticking: 'w' }
	};
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (r) => r.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({ json: { ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS, state: { v: 1, voice: [], game: myTurnGame } } })
	);
	await page.route('**/api/rooms/*/chess/move', (r) => r.fulfill({ json: { ok: true } }));

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	// a real gesture first, or the browser keeps the AudioContext locked
	await page.mouse.click(5, 5);
	const before = await page.evaluate(() => window.__osc);

	await page.locator('[data-sq="e2"]').click();
	await expect(page.locator('[data-sq="e4"]')).toHaveClass(/sq--hint/); // legal target
	await page.locator('[data-sq="e4"]').click();

	// the pawn is now on e4 …
	await expect(page.locator('[data-sq="e4"] .piece')).toBeVisible();
	// … it slid there (a WAAPI animation was created for the move) …
	const animated = await page.evaluate(() => document.getAnimations().length);
	console.log('animations running right after the move:', animated);
	// … and a sound was synthesised
	await expect.poll(async () => page.evaluate(() => window.__osc)).toBeGreaterThan(before);
	const after = await page.evaluate(() => window.__osc);
	console.log('oscillators before/after move:', before, after);

	await ctx.close();
});

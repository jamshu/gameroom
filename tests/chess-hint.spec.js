import { test, expect, devices } from '@playwright/test';

/**
 * The premium "Best move" hint. Driven off mocked API responses (the app is
 * CSR-only), but the ENGINE IS REAL: the vendored Stockfish in /static/engine is
 * booted and searched, because "the button appears" is not the thing that can
 * break — the worker, the wasm path and the UCI handshake are.
 *
 * The fixture position deliberately has BLACK to move while we are playing white.
 * That is the "check the opponent's best move" case, and it is the reason the
 * button is not gated on whose turn it is.
 */

// Mobile context, same reason as chess-fullscreen.spec.js: pointer is coarse, so
// the board takes the CSS-overlay fullscreen path. On a desktop context the click
// goes to native requestFullscreen, which is not dependable headless.
test.use({ ...devices['Pixel 5'] });

const ROOM = {
	id: 1, name: 'Chess Test', gameType: 'chess', status: 'playing',
	hostUid: 100, hostName: 'Me', maxPlayers: 2, drawsTotal: 0
};
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Me', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Opp', status: 'accepted', role: 'player', score: 0, online: true }
];
// after 1.e4 — black to move, and we are white
const game = {
	type: 'chess',
	players: { w: 100, b: 101 },
	fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
	moves: ['e4'],
	result: null,
	clock: { w: 600000, b: 600000, ticking: 'b' }
};

// fool's mate — white is checkmated, so the game is over AND the live position
// has no legal move at all
const finishedGame = {
	type: 'chess',
	players: { w: 100, b: 101 },
	fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
	moves: ['f3', 'e5', 'g4', 'Qh4#'],
	result: 'b',
	clock: { w: 600000, b: 600000, ticking: null }
};

async function mockBackend(page, user, g = game) {
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({ json: { ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS, state: { v: 1, voice: [], game: g } } })
	);
}

test('a free user gets no hint button, and never fetches the engine', async ({ page }) => {
	const engineRequests = [];
	page.on('request', (r) => r.url().includes('/engine/') && engineRequests.push(r.url()));

	await mockBackend(page, { uid: 100, name: 'Me' }); // no `premium`
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	await expect(page.getByRole('button', { name: /Best move/ })).toHaveCount(0);
	// fullscreen has its own copy of the controls — it must be absent there too
	await page.getByTitle('Fullscreen board').click({ force: true });
	await expect(page.locator('.board-wrap--fs')).toBeVisible();
	await expect(page.getByRole('button', { name: /Best move/ })).toHaveCount(0);

	// the engine is ~656 KB; a free user must not pay for it
	expect(engineRequests).toEqual([]);
});

test('a premium user gets a real engine suggestion, on the opponent\'s turn', async ({ page }) => {
	// booting the wasm and searching to depth 15 is a few seconds
	test.setTimeout(90000);

	await mockBackend(page, { uid: 100, name: 'Me', premium: true });
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	// it is black's move and we are white — the button is still offered
	await expect(page.locator('.chess-player').last()).toContainText('Me');
	const btn = page.getByRole('button', { name: /Best move/ });
	await expect(btn).toBeVisible();

	await btn.click();

	// a real move came back from the engine, named in SAN …
	const san = page.locator('.hint-san b');
	await expect(san).toBeVisible({ timeout: 60000 });
	const move = await san.textContent();
	console.log('engine suggested:', move);
	expect(move).toMatch(/^[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?[+#]?$|^O-O(-O)?$/);

	// … and it is highlighted on exactly the two squares it moves between
	const best = page.locator('.sq--best');
	await expect(best).toHaveCount(2);
	await page.screenshot({ path: 'test-results/chess-hint.png' });

	// the suggestion is advice, not a move: the board has not changed
	await expect(page.locator('[data-sq="e4"] .piece')).toBeVisible();
	expect(await page.locator('.piece').count()).toBe(32);
});

test('the hint outlives the game, and a mated position answers instead of hanging', async ({ page }) => {
	test.setTimeout(90000);

	await mockBackend(page, { uid: 100, name: 'Me', premium: true }, finishedGame);
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	// the game has a result, but post-mortem is exactly when you want the engine
	const btn = page.getByRole('button', { name: /Best move/ });
	await expect(btn).toBeVisible();

	// The live position is checkmate. Stockfish 10 answers `info depth 0` and then
	// says nothing at all — no `bestmove` ever arrives — so without the chess.js
	// short-circuit in analyse() this would spin until the 20s engine timeout and
	// report an error. It must come back promptly with a plain answer instead.
	await btn.click();
	await expect(page.locator('.hint-san')).toContainText('No moves here', { timeout: 10000 });
	await expect(page.locator('.sq--best')).toHaveCount(0);
	await expect(page.locator('.error-text')).toHaveCount(0);

	// step back to a position that does have moves — the hint works there
	await page.getByTitle('Previous move').click();
	await btn.click();
	await expect(page.locator('.hint-san b')).toBeVisible({ timeout: 60000 });
	console.log('post-mortem suggestion:', await page.locator('.hint-san b').textContent());
	await expect(page.locator('.sq--best')).toHaveCount(2);
});

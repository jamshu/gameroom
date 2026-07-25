import { test, expect } from '@playwright/test';

/**
 * The reported iPhone bug, staged exactly: a write reaches the server and the
 * RESPONSE is lost. `route.abort()` reproduces that shape — fetch rejects with a
 * TypeError, which is the only thing that produces the "Connection lost" message,
 * while the server (here, the mock) has already seen the request.
 *
 * What the player did next is the actual defect. The board still showed the old
 * position, so they tapped the token again — and every tap was another write,
 * because the failure handler cleared `posting` and re-enabled the button. These
 * cases pin the control shut until authoritative state answers.
 */

const ME = { uid: 100, name: 'Host' };
const ROOM = {
	id: 1, name: 'Offline Test', gameType: 'ludo', status: 'playing',
	hostUid: 100, hostName: 'Host', maxPlayers: 4, drawsTotal: 0
};
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Host', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Bee', status: 'accepted', role: 'player', score: 0, online: true }
];

const baseGame = (over = {}) => ({
	type: 'ludo',
	players: [100, 101],
	colors: { 100: 'red', 101: 'yellow' },
	turnIdx: 0,
	dice: null,
	rolled: false,
	sixStreak: 0,
	tokens: { 100: [-1, -1, -1, -1], 101: [-1, -1, -1, -1] },
	lastEvent: null,
	finished: [],
	result: null,
	...over
});

// Mid-turn, a 6 already rolled: all four yard tokens are legal, so nothing
// auto-plays and the tap under test is the player's own.
const ROLLED_SIX = baseGame({
	dice: 6,
	rolled: true,
	sixStreak: 1,
	lastEvent: { kind: 'roll', uid: 100, die: 6 }
});

/**
 * @param write  route handler for the ludo write under test
 * @returns box whose `.game`/`.v` the poll serves — mutate to reconcile
 */
async function mockBackend(page, { path, write, game = ROLLED_SIX } = {}) {
	const box = { game, v: 1, polls: 0, failPolls: 0 };
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (x) => x.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) => {
		box.polls++;
		// `failPolls` lets a test drop the next N polls, which is what a timed-out
		// poll looks like to the client: the offline path, errorStreak++.
		if (box.failPolls > 0) {
			box.failPolls--;
			return x.abort();
		}
		x.fulfill({
			json: {
				ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS,
				state: { v: box.v, voice: [], game: box.game }
			}
		});
	});
	if (path) await page.route(path, write);
	return box;
}

/**
 * A single failed poll must not freeze the board. The error backoff used to be a
 * MULTIPLIER on whatever tier applied, and while push is connected that tier is
 * the 60s safety net — so one timed-out poll bought a two-minute stale board and
 * a red banner over it. The ladder is now its own thing: 1.5s, 3s, 6s…
 */
test('one failed poll recovers in seconds and never shows a banner', async ({ page }) => {
	const box = await mockBackend(page);

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	const seen = box.polls;

	box.failPolls = 1;
	// the state that the next successful poll should deliver
	box.v = 2;
	box.game = baseGame({
		tokens: { 100: [0, -1, -1, -1], 101: [-1, -1, -1, -1] },
		lastEvent: { kind: 'move', uid: 100, token: 0, die: 6 }
	});

	// recovery is the next rung of the ladder (~1.5s), not the 60s safety tier
	await expect
		.poll(() => box.polls, { timeout: 8000 })
		.toBeGreaterThan(seen + 1);
	await expect(page.getByText('Your turn — tap the die to roll.')).toBeVisible({ timeout: 8000 });
	// and a blip that healed itself was never worth alarming anyone about
	await expect(page.locator('.error-text')).toHaveCount(0);
});

test('a sustained outage does say so, in words that fit a failed read', async ({ page }) => {
	const box = await mockBackend(page);

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();

	box.failPolls = 4;
	// From the SECOND consecutive failure the banner appears. "may not have gone
	// through" is write wording — a poll is a read and never went anywhere.
	const banner = page.locator('.error-text');
	await expect(banner).toContainText('Connection trouble', { timeout: 15000 });
	await expect(banner).not.toContainText('gone through');

	// …and it clears itself once polls succeed again
	await expect(banner).toHaveCount(0, { timeout: 20000 });
});

test('a lost move response does not let repeated taps pile up writes', async ({ page }) => {
	let posts = 0;
	await mockBackend(page, {
		path: '**/api/rooms/*/ludo/move',
		// reached the server, answer never came back
		write: (r) => { posts++; r.abort(); }
	});

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	// every click here is `force`: movable tokens bob forever, so Playwright's
	// stability check would never settle. It also means the DOM's own disabled
	// state is the only thing deciding whether a tap becomes a write — which is
	// exactly what this test is about.
	const token = page.locator('.token').first();
	await expect(token).toBeEnabled();

	await token.click({ force: true });
	// the impatient part: nothing moved, so tap it again and again
	for (let i = 0; i < 5; i++) await token.click({ force: true });

	// the headline claim, asserted first so it is what fails if this regresses
	expect(posts, 'six taps must produce exactly one write').toBe(1);
	await expect(page.locator('.syncing')).toBeVisible();
	// and it stays quiet — the write most likely landed
	await expect(page.locator('.error-text')).toHaveCount(0);
});

test('a lost move response resolves silently once state catches up', async ({ page }) => {
	const box = await mockBackend(page, {
		path: '**/api/rooms/*/ludo/move',
		write: (r) => r.abort()
	});

	await page.goto('/room/1');
	await expect(page.locator('.token--movable').first()).toBeVisible();
	// force: movable tokens bob forever, so the stability check never settles
	await page.locator('.token').first().click({ force: true });
	await expect(page.locator('.syncing')).toBeVisible();

	// the write HAD landed; the poll now says so (a 6 grants another roll)
	box.v = 2;
	box.game = baseGame({
		tokens: { 100: [0, -1, -1, -1], 101: [-1, -1, -1, -1] },
		sixStreak: 1,
		lastEvent: { kind: 'move', uid: 100, token: 0, die: 6 }
	});

	await expect(page.locator('.syncing')).toHaveCount(0, { timeout: 10000 });
	// the player is never told anything went wrong, because nothing did
	await expect(page.locator('.error-text')).toHaveCount(0);
	await expect(page.getByText('Your turn — tap the die to roll.')).toBeVisible();
});

test('a move that never reconciles gives up and unlocks the board', async ({ page }) => {
	// poll keeps serving v=1, so the board never answers the pending write
	await mockBackend(page, {
		path: '**/api/rooms/*/ludo/move',
		write: (r) => r.abort()
	});

	await page.goto('/room/1');
	await expect(page.locator('.token--movable').first()).toBeVisible();
	// force: movable tokens bob forever, so the stability check never settles
	await page.locator('.token').first().click({ force: true });
	await expect(page.locator('.syncing')).toBeVisible();

	// RECONCILE_MS is 6s — after that the player has to be told
	await expect(page.locator('.error-text')).toContainText('Connection lost', { timeout: 12000 });
	await expect(page.locator('.syncing')).toHaveCount(0);
	// and the board is usable again rather than stuck
	await expect(page.locator('.token--movable').first()).toBeVisible();
});

test('a lost roll response does not let repeated taps pile up writes', async ({ page }) => {
	let posts = 0;
	await mockBackend(page, {
		path: '**/api/rooms/*/ludo/roll',
		write: (r) => { posts++; r.abort(); },
		game: baseGame() // my turn, nothing rolled yet
	});

	await page.goto('/room/1');
	const die = page.locator('.dice3d');
	await expect(page.getByText('Your turn — tap the die to roll.')).toBeVisible();

	for (let i = 0; i < 6; i++) await die.click({ force: true });

	expect(posts, 'six taps must produce exactly one roll').toBe(1);
	await expect(page.locator('.syncing')).toBeVisible();
	await expect(page.locator('.error-text')).toHaveCount(0);
	// the die stays visibly in the air rather than dropping to a wrong face
	await expect(die).toHaveClass(/dice3d--rolling/);
});

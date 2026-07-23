import { test, expect } from '@playwright/test';

// A LudoBoard driven entirely off mocked API responses (the app is CSR-only, so
// page.route fully controls its world). We assert the two things the "rolling a
// 6 just passes the turn" report was really about: the die must show the ACTUAL
// rolled value (a passed non-6 used to render a phantom 6), and a real 6 must
// open up movable tokens instead of passing.

const ME = { uid: 100, name: 'Red' };

const ROOM = {
	id: 1,
	name: 'Ludo Test',
	gameType: 'ludo',
	status: 'playing',
	hostUid: 100,
	hostName: 'Red',
	maxPlayers: 4,
	drawsTotal: 0
};

const MEMBERS = [
	{ id: 1, uid: 100, name: 'Red', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Yellow', status: 'accepted', role: 'player', score: 0, online: true }
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

/** Wire up every backend call the room page makes. `rollResponse` is what
 *  POST /ludo/roll returns for that test's scenario. */
async function mockBackend(page, rollResponse) {
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	// 501 → the client stays on polling and never opens an Ably connection.
	await page.route('**/api/realtime/token**', (r) => r.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	// room detail (accepted member → the board mounts)
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	// the safety poll: hands over the initial ludo state at v=1
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({ json: { ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS, state: { v: 1, voice: [], game: baseGame() } } })
	);
	// the roll — returns the scripted post-roll state at a higher version
	await page.route('**/api/rooms/*/ludo/roll', (r) => r.fulfill({ json: rollResponse }));
}

test('a non-6 shows the real die value and passes the turn (no phantom 6)', async ({ page }) => {
	await mockBackend(page, {
		ok: true,
		die: 2,
		state: { v: 2, voice: [], game: baseGame({ turnIdx: 1, lastEvent: { kind: 'pass', uid: 100, die: 2 } }) }
	});

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await expect(page.getByText('Your turn — tap the die to roll.')).toBeVisible();

	await page.locator('.die').click({ force: true });

	// the turn correctly passes, and the UI explains WHY with the real value…
	await expect(page.locator('.roll-log')).toContainText('rolled 2');
	await expect(page.locator('.roll-log')).toContainText('turn passes');
	await expect(page.getByText("Yellow's turn…")).toBeVisible();
	// …and the die face is exactly 2 pips — never the phantom 6 the bug rendered.
	await expect(page.locator('.die .pip--on')).toHaveCount(2);
});

test('rolling a 6 opens up movable tokens instead of passing', async ({ page }) => {
	await mockBackend(page, {
		ok: true,
		die: 6,
		state: { v: 2, voice: [], game: baseGame({ dice: 6, rolled: true, sixStreak: 1, lastEvent: { kind: 'roll', uid: 100, die: 6 } }) }
	});

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await page.locator('.die').click({ force: true });

	// still my turn, now prompted to move, with all four yard tokens playable
	await expect(page.getByText('tap a glowing token')).toBeVisible();
	await expect(page.locator('.die .pip--on')).toHaveCount(6);
	await expect(page.locator('.token--movable')).toHaveCount(4);
});

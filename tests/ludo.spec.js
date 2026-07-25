import { test, expect } from '@playwright/test';

// A LudoBoard driven entirely off mocked API responses (the app is CSR-only, so
// page.route fully controls its world). We assert the two things the "rolling a
// 6 just passes the turn" report was really about: the die must show the ACTUAL
// rolled value (a passed non-6 used to render a phantom 6), and a real 6 must
// open up movable tokens instead of passing.
//
// The die value is now the SERVER's, so each test scripts it in `rollResponse`
// rather than deriving it from the gesture. The face is read off the element's
// `data-value` — counting lit pips can't work, because all six faces of the CSS
// cube are in the DOM at once.

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

	await page.locator('.dice3d').click();

	// the turn correctly passes, and the UI explains WHY with the real value…
	await expect(page.locator('.roll-log')).toContainText('rolled 2');
	await expect(page.locator('.roll-log')).toContainText('turn passes');
	await expect(page.getByText("Yellow's turn…")).toBeVisible();
	// …and the die settles on 2 — never the phantom 6 the bug rendered.
	await expect(page.locator('.dice3d')).toHaveAttribute('data-value', '2');
});

test('rolling a 6 opens up movable tokens instead of passing', async ({ page }) => {
	await mockBackend(page, {
		ok: true,
		die: 6,
		state: { v: 2, voice: [], game: baseGame({ dice: 6, rolled: true, sixStreak: 1, lastEvent: { kind: 'roll', uid: 100, die: 6 } }) }
	});

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await page.locator('.dice3d').click();

	// still my turn, now prompted to move, with all four yard tokens playable
	await expect(page.getByText('tap a glowing token')).toBeVisible();
	await expect(page.locator('.dice3d')).toHaveAttribute('data-value', '6');
	await expect(page.locator('.token--movable')).toHaveCount(4);
});

// The die is thrown BEFORE the number is known — that's the whole point of the
// server owning it. So the throw has to be a real airborne phase that ends when
// the result lands, not a class the CSS ignores (which is what .dice3d--rolling
// used to be) and not something that resolves before anyone can see it.
test('the die is airborne while the roll is in flight, then settles', async ({ page }) => {
	await mockBackend(page, {
		ok: true,
		die: 3,
		state: { v: 2, voice: [], game: baseGame({ dice: 3, rolled: true, lastEvent: { kind: 'roll', uid: 100, die: 3 } }) }
	});

	await page.goto('/room/1');
	const die = page.locator('.dice3d');
	await expect(page.locator('.board')).toBeVisible();
	await expect(die).toHaveAttribute('data-value', '1'); // untouched starting face

	await die.click();

	// mid-throw: the class is on AND the browser is actually running a keyframe
	await expect(die).toHaveClass(/dice3d--rolling/);
	const spinning = await die.evaluate((el) => el.getAnimations().map((a) => a.animationName ?? ''));
	expect(spinning.join(','), 'the throw keyframe must be running').toContain('dthrow');

	// …and it comes down on the server's number
	await expect(die).not.toHaveClass(/dice3d--rolling/);
	await expect(die).toHaveAttribute('data-value', '3');
});

// A forced move auto-plays, and it must wait for the die. The state that says
// "you rolled a 3" arrives while the die is still in the air, so firing the move
// off that state immediately would walk the token before the number it's walking
// by has landed — the consequence animating ahead of its cause.
test('a forced auto-move waits for the die to land', async ({ page }) => {
	// one token already out: a 3 can't leave the yard, so token 0 is the only move
	const started = { 100: [5, -1, -1, -1], 101: [-1, -1, -1, -1] };
	await mockBackend(page, {
		ok: true,
		die: 3,
		state: {
			v: 2,
			voice: [],
			game: baseGame({ tokens: started, dice: 3, rolled: true, lastEvent: { kind: 'roll', uid: 100, die: 3 } })
		}
	});
	let movedWhileAirborne = null;
	await page.route('**/api/rooms/*/ludo/move', async (r) => {
		movedWhileAirborne = await page
			.locator('.dice3d')
			.evaluate((el) => el.classList.contains('dice3d--rolling'));
		await r.fulfill({
			json: {
				ok: true,
				state: {
					v: 3,
					voice: [],
					game: baseGame({
						tokens: { ...started, 100: [8, -1, -1, -1] },
						turnIdx: 1,
						lastEvent: { kind: 'move', uid: 100, token: 0, die: 3 }
					})
				}
			}
		});
	});

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await page.locator('.dice3d').click();

	await expect(page.getByText("Yellow's turn…")).toBeVisible(); // the auto-move landed
	expect(movedWhileAirborne, 'the auto-move must not fire mid-throw').toBe(false);
	await expect(page.locator('.dice3d')).toHaveAttribute('data-value', '3');
});

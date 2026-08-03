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
		{ id: 'p0', color: 'w', x: 560, y: 500, pocketed: false },
		{ id: 'p1', color: 'b', x: 440, y: 500, pocketed: false }
	],
	scores: { w: 0, b: 0 },
	lastEvent: null, result: null
};

/**
 * `state` is a getter so a test can swap what the next poll returns — the store
 * version-gates on `state.v`, so bumping it is how you simulate anything else in
 * the room writing (a voice join, a member change) without a game move.
 */
async function mockBackend(page, gameType, game, stateRef = { v: 1 }) {
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: room(gameType), members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({
			json: {
				ok: true, cursor: 0, events: [], room: room(gameType), members: stateRef.members || MEMBERS,
				state: { v: stateRef.v, voice: [], game: stateRef.game || game }
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

	// The canvas has no DOM to assert, so read the felt pixel back out of it.
	// Sampled at the very centre: the felt is a RADIAL gradient whose first stop
	// sits at radius 100, so everything inside that is flat `shade(felt, +0.1)` —
	// anywhere further out lands mid-ramp on a value that says nothing about the
	// palette. The centre spot is bare (no coin sits there), so nothing covers it.
	const feltAt = () =>
		canvas.evaluate((c) => {
			const d = c.getContext('2d').getImageData(500, 500, 1, 1).data;
			return `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
		});

	// Maple felt #e9d3a3 lightened 10% toward white by shade() → rgb(235,215,172)
	expect(await feltAt()).toBe('#ebd7ac');

	await page.getByRole('button', { name: '🎨' }).click();
	await expect(page.locator('.themes .sw')).toHaveCount(4);
	await page.getByRole('button', { name: 'Slate' }).click();
	// Slate felt #cfd6dd, same 10% → rgb(212,218,224)
	expect(await feltAt()).toBe('#d4dae0');
	await page.screenshot({ path: 'test-results/carrom-theme-slate.png' });

	await page.reload();
	await expect(canvas).toBeVisible();
	expect(await feltAt()).toBe('#d4dae0');
});

/**
 * Requirement that everyone sits at the bottom of their OWN screen: the board is
 * rotated per seat, so seat 1 must see its own baseline along the bottom edge
 * and seat 0's along the top — the mirror of what seat 0 sees.
 */
test('each seat sees its own baseline at the bottom of the board', async ({ page }) => {
	// seat 1 (uid 101) is on strike, so its baseline is the accent-coloured one
	await mockBackend(page, 'carroms', { ...CARROMS, turnIdx: 1 });
	const canvas = page.locator('.carrom-canvas');

	/** Is the accent line (--accent, #ff4d6d) painted across this row? */
	const accentOnRow = (y) =>
		canvas.evaluate((c, row) => {
			const d = c.getContext('2d').getImageData(200, row, 600, 1).data;
			for (let i = 0; i < d.length; i += 4) {
				if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] > 60 && d[i + 2] < 160) return true;
			}
			return false;
		}, y);

	// seat 0's view: the striker on strike is seat 1's, so it reads at the TOP
	await page.goto('/room/1');
	await expect(canvas).toBeVisible();
	expect(await accentOnRow(120)).toBe(true); // opponent's line, far edge
	expect(await accentOnRow(880)).toBe(false);
	await page.screenshot({ path: 'test-results/carrom-seat0-view.png' });

	// …and seat 1's view of the same board is the exact mirror
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: { uid: 101, name: 'Yellow' } } }));
	await page.reload();
	await expect(canvas).toBeVisible();
	expect(await accentOnRow(880)).toBe(true); // their own line, near edge
	expect(await accentOnRow(120)).toBe(false);
	await page.screenshot({ path: 'test-results/carrom-seat1-view.png' });
});

/**
 * The board must only re-animate when a SHOT arrives. `game.v` is the whole
 * room's state version — a voice join or a member change bumps it with no move
 * behind it, and replaying off that would fling already-settled coins around.
 * lastEvent.seq is what tells the two apart, and nothing else here reaches it.
 */
test('a state bump with no new shot leaves the board alone', async ({ page }) => {
	const shot = {
		...CARROMS,
		turnIdx: 1,
		// A shot by the OTHER player, already applied and already seen. Aimed
		// squarely down the black coin's file, so replaying it again would knock
		// that coin clean out of the box sampled below — a miss would make this
		// test prove nothing.
		lastEvent: { kind: 'shot', seq: 4, uid: 101, pocketed: 0, foul: false, shot: { sx: 440, sy: 120, vx: 0, vy: 34 } }
	};
	const stateRef = { v: 1, game: shot };
	await mockBackend(page, 'carroms', shot, stateRef);
	await page.goto('/room/1');
	const canvas = page.locator('.carrom-canvas');
	await expect(canvas).toBeVisible();

	// Watch the black coin for the whole window. A single before/after comparison
	// would prove nothing: a spurious replay animates and then snaps back to the
	// authoritative positions, so it is only visible WHILE it runs. Sampling
	// continuously is what catches it. The threshold is tight enough that the
	// striker passing through (a mid blue) never counts as the coin.
	await canvas.evaluate((c) => {
		window.__samples = [];
		window.__sampler = setInterval(() => {
			const d = c.getContext('2d').getImageData(415, 480, 50, 40).data;
			let dark = 0;
			for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark++;
			window.__samples.push(dark);
		}, 50);
	});

	// A member change is the everyday case: it writes room state, so the envelope
	// version moves, but the game is untouched.
	stateRef.v = 2;
	stateRef.members = MEMBERS.map((m) => (m.uid === 101 ? { ...m, name: 'Amber' } : m));
	// the rename landing proves the new version was really ingested — without it
	// this test would pass simply by nothing ever arriving
	await expect(page.locator('.turn-chip', { hasText: 'Amber' })).toBeVisible({ timeout: 15000 });
	// …and keep watching PAST it: the rename lands on the same poll as the new
	// version, so a replay it wrongly triggered would only start here. A full
	// shot runs ~1.5s.
	await page.waitForTimeout(2000);

	const samples = await canvas.evaluate((c) => {
		clearInterval(window.__sampler);
		return window.__samples;
	});
	expect(samples.length).toBeGreaterThan(5);
	// every sample identical → the coins never moved across the version bump
	expect([...new Set(samples)]).toHaveLength(1);
	expect(samples[0]).toBeGreaterThan(0); // and the black coin was really there
});

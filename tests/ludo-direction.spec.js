import { test, expect } from '@playwright/test';

/**
 * Empirical check of which way Ludo tokens travel around the shared ring.
 *
 * The server only knows abstract ring indices (0..51); the physical direction is
 * decided entirely by the client TRACK array + tokenCentre() in LudoBoard.svelte.
 * So we drive the board off mocked state (the app is CSR-only), place one RED
 * token at four increasing ring positions that sit on the four arms of the cross,
 * read where each actually renders, and compute the polygon winding.
 *
 * Screen coords have y pointing DOWN, so a POSITIVE shoelace sum = CLOCKWISE.
 * Standard Ludo is clockwise, so we assert that — a failure means the board
 * renders anticlockwise (the reported bug).
 */

const ME = { uid: 100, name: 'Red' };
const ROOM = {
	id: 1, name: 'Ludo Test', gameType: 'ludo', status: 'playing',
	hostUid: 100, hostName: 'Red', maxPlayers: 4, drawsTotal: 0
};
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Red', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Yellow', status: 'accepted', role: 'player', score: 0, online: true }
];

// Red's four tokens parked at ring positions 0, 13, 26, 39 — one on each arm of
// the cross, sampled in increasing-position order around the ring.
const SAMPLE_POS = [0, 13, 26, 39];

const game = {
	type: 'ludo',
	players: [100, 101],
	colors: { 100: 'red', 101: 'yellow' },
	turnIdx: 1, // not our turn — we only want a static render
	dice: null,
	rolled: false,
	sixStreak: 0,
	tokens: { 100: SAMPLE_POS, 101: [-1, -1, -1, -1] },
	lastEvent: null,
	finished: [],
	result: null
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

test('ludo tokens travel clockwise around the ring', async ({ page }) => {
	await mockBackend(page);
	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible();
	await expect(page.locator('.token')).toHaveCount(8); // 4 red + 4 yellow (yard)

	// read the centre of each red token in ascending ring-position order
	const points = [];
	for (let i = 1; i <= 4; i++) {
		const box = await page.getByRole('button', { name: `red token ${i}` }).boundingBox();
		points.push({ pos: SAMPLE_POS[i - 1], x: box.x + box.width / 2, y: box.y + box.height / 2 });
	}
	console.log('sampled token centres (ascending ring position):');
	for (const p of points) console.log(`  pos ${p.pos}: x=${p.x.toFixed(1)} y=${p.y.toFixed(1)}`);

	// shoelace over the 4 points in ring order
	let shoelace = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		shoelace += a.x * b.y - b.x * a.y;
	}
	const dir = shoelace > 0 ? 'CLOCKWISE' : 'ANTICLOCKWISE';
	console.log(`shoelace=${shoelace.toFixed(0)} => ${dir} (screen y is down: positive = clockwise)`);

	expect(shoelace, `token travel direction is ${dir}`).toBeGreaterThan(0);
});

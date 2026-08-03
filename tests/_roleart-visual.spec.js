// TEMPORARY — visual verification of RoleArt across every thief-finder phase.
// Delete after review.
import { test, expect } from '@playwright/test';

const ME = { uid: 100, name: 'Me' };
const OUT = process.env.SHOT_DIR;

const room = {
	id: 1, name: 'Role Art', gameType: 'thief_finder', status: 'playing',
	hostUid: 999, hostName: 'Other', maxPlayers: 8, drawsTotal: 5
};
const members = [
	{ id: 1, uid: 100, name: 'Me', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Bee', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 3, uid: 102, name: 'Cee', status: 'accepted', role: 'player', score: 0, online: true }
];

const base = {
	type: 'thief_finder', players: [100, 101, 102], draw: 2, drawsTotal: 5,
	phase: 'picking', policeUid: null, envelopeCount: 3, claims: {},
	myEnvelope: null, myRole: null, lastResult: null, revealHoldMs: 0,
	totals: { 100: 1000, 101: 800, 102: 0 }
};

async function mount(page, game) {
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room, members, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({ json: { ok: true, cursor: 0, events: [], room, members, state: { v: 1, voice: [], game } } })
	);
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: '🕵️ Thief Finder' })).toBeVisible();
}

const shot = (page, name) => page.locator('.room-main .card').first().screenshot({ path: `${OUT}/${name}.png` });

test('picking: own thief card, envelope grid, police banner', async ({ page }) => {
	await mount(page, {
		...base, phase: 'picking', policeUid: 101,
		claims: { 0: 100, 1: 101 }, myEnvelope: 0, myRole: 'Thief'
	});
	// own envelope shows the art, untaken ones keep the letter glyph
	await expect(page.locator('.envelope--mine img.role-art')).toBeVisible();
	await expect(page.locator('.env-emoji')).toHaveText('✉️');
	// police banner: art next to the gold-ringed avatar, word kept in the badge
	await expect(page.locator('.police-banner img.role-art')).toBeVisible();
	await expect(page.locator('.police-badge')).toHaveText('Police');
	await shot(page, '1-picking');
});

test('guessing: secret King card falls back to emoji, police art shows', async ({ page }) => {
	await mount(page, { ...base, phase: 'guessing', policeUid: 100, myRole: 'King' });
	// King has no art on disk -> emoji branch, no <img>
	await expect(page.locator('.my-card .role-art--emo')).toHaveText('👑');
	await expect(page.locator('.my-card img')).toHaveCount(0);
	await expect(page.locator('.police-banner img.role-art')).toBeVisible();
	await shot(page, '2-guessing');
});

test('reveal: verdict pills + per-row chips, art and emoji side by side', async ({ page }) => {
	await mount(page, {
		...base, phase: 'reveal', draw: 2, revealHoldMs: 999000,
		lastResult: {
			draw: 2, roles: { 100: 'King', 101: 'Police', 102: 'Thief' },
			accusedUid: 100, thiefUid: 102, correct: false,
			points: { 100: 1000, 101: 0, 102: 1000 }
		}
	});
	// three chips: King emoji, Police + Thief art
	await expect(page.locator('.chip--role')).toHaveCount(3);
	await expect(page.locator('.chip--role img.role-art')).toHaveCount(2);
	await expect(page.locator('.chip--role .role-art--emo')).toHaveText('👑');
	// verdict: thief pill carries art AND the word; innocent pill has neither
	await expect(page.locator('.pill--red img.role-art')).toBeVisible();
	await expect(page.locator('.pill--red .pill-badge')).toHaveText('Thief');
	await expect(page.locator('.pill--dim .pill-badge')).toHaveText('innocent');
	await expect(page.locator('.pill--dim img.role-art')).toHaveCount(0);
	await shot(page, '3-reveal');
});

test('missing file: art 404s, every site falls back to emoji, one request only', async ({ page }) => {
	let hits = 0;
	await page.route('**/roles/*.png', (x) => {
		hits++;
		x.fulfill({ status: 404, body: '' });
	});
	await mount(page, {
		...base, phase: 'reveal', draw: 2, revealHoldMs: 999000,
		lastResult: {
			draw: 2, roles: { 100: 'King', 101: 'Police', 102: 'Thief' },
			accusedUid: 100, thiefUid: 102, correct: false,
			points: { 100: 1000, 101: 0, 102: 1000 }
		}
	});
	await expect(page.locator('.chip--role')).toHaveCount(3);
	// no broken images anywhere; all three chips on the emoji branch
	await expect(page.locator('img.role-art')).toHaveCount(0);
	await expect(page.locator('.chip--role .role-art--emo')).toHaveCount(3);
	await expect(page.locator('.pill--red .role-art--emo')).toHaveText('🥷');
	// the module-level memo means each dead path is asked for once, not per instance
	expect(hits).toBe(2);
	await shot(page, '4-fallback');
});

test('narrow viewport: banner wraps, envelope cells hold their height', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 900 });
	await mount(page, {
		...base, phase: 'picking', policeUid: 101,
		claims: { 0: 100, 1: 101 }, myEnvelope: 0, myRole: 'Thief'
	});
	const mineBox = await page.locator('.envelope--mine').boundingBox();
	const otherBox = await page.locator('.envelope').last().boundingBox();
	// the own-envelope cell must not outgrow min-height:96px, or picking one
	// stretches every cell in the grid
	expect(mineBox.height).toBeLessThanOrEqual(96);
	expect(Math.abs(mineBox.height - otherBox.height)).toBeLessThan(1);
	await shot(page, '5-narrow');
});

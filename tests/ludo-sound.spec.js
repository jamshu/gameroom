import { test, expect } from '@playwright/test';

/**
 * Ludo used to sound only rolls, captures and homes — moving a token or having
 * a turn passed was silent. Sound is state-driven (so spectators hear it too),
 * so this drives it the way the room really does: a poll delivering a new state
 * version carrying `lastEvent`.
 *
 * Counts synthesised oscillators, the same trick chess-fullscreen.spec.js uses
 * to prove a sound was actually produced rather than merely requested.
 */

const ME = { uid: 100, name: 'Red' };
const ROOM = {
	id: 1, name: 'Ludo Sound', gameType: 'ludo', status: 'playing',
	hostUid: 100, hostName: 'Red', maxPlayers: 4, drawsTotal: 0
};
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Red', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Yellow', status: 'accepted', role: 'player', score: 0, online: true }
];
const game = (over = {}) => ({
	type: 'ludo', players: [100, 101], colors: { 100: 'red', 101: 'yellow' },
	turnIdx: 1, dice: null, rolled: false, sixStreak: 0,
	tokens: { 100: [-1, -1, -1, -1], 101: [-1, -1, -1, -1] },
	lastEvent: null, finished: [], result: null, ...over
});

/** Serves v=1 with no event, then v=2 carrying `event` once `armed` flips. */
async function mockBackend(page, event) {
	let armed = false;
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
	await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (r) => r.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (r) => r.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (r) =>
		r.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (r) =>
		r.fulfill({
			json: {
				ok: true, cursor: 0, events: [], room: ROOM, members: MEMBERS,
				state: armed
					? { v: 2, voice: [], game: game({ lastEvent: event }) }
					: { v: 1, voice: [], game: game() }
			}
		})
	);
	return () => (armed = true);
}

/** A gesture first: an AudioContext cannot start before one. */
async function unlockAudio(page) {
	await page.getByRole('button', { name: 'Board colours' }).click();
	await page.getByRole('button', { name: 'Board colours' }).click();
}

for (const [label, event] of [
	['a token move', { kind: 'move', uid: 101, token: 0, die: 3 }],
	['a passed turn', { kind: 'pass', uid: 101, die: 3 }],
	['a capture', { kind: 'capture', uid: 101, token: 0, die: 3 }]
]) {
	test(`${label} by another player is audible`, async ({ page }) => {
		const fire = await mockBackend(page, event);
		await page.goto('/room/1');
		await expect(page.locator('.board')).toBeVisible();
		await unlockAudio(page);

		// the arrival state must NOT replay a sound (soundReady guards that)
		const before = await page.evaluate(() => window.__osc);

		fire();
		await expect.poll(() => page.evaluate(() => window.__osc), { timeout: 8000 }).toBeGreaterThan(before);
		console.log(label, 'oscillators before/after:', before, await page.evaluate(() => window.__osc));
	});
}

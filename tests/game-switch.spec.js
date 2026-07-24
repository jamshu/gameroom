import { test, expect } from '@playwright/test';

/**
 * Changing a room's game without rebuilding the room. Driven off mocked API
 * responses (the app is CSR-only, so page.route fully controls its world).
 *
 * Asserts the three things the feature really rests on: the host can switch from
 * the lobby and from the final leaderboard; the lobby tells them up front how
 * many people the switch will re-seat (roles are capacity-gated per game, so a
 * 5-player Thief Finder room switched to chess MUST demote 3 or `start` rejects
 * it forever); and a poll left in flight across the switch can't revert it.
 */

const ME = { uid: 100, name: 'Host' };

const room = (over = {}) => ({
	id: 1, name: 'Switch Test', gameType: 'thief_finder', status: 'lobby',
	hostUid: 100, hostName: 'Host', maxPlayers: 8, drawsTotal: 5, ...over
});
const member = (id, uid, name, role = 'player') =>
	({ id, uid, name, status: 'accepted', role, score: 0, online: true });

const CHESS = room({ gameType: 'chess', drawsTotal: 0 });
const FOUR = [1, 2, 3, 4].map((i) => member(i, 99 + i, `P${i}`));
const RESEATED = [
	member(1, 100, 'P1'), member(2, 101, 'P2'),
	member(3, 102, 'P3', 'spectator'), member(4, 103, 'P4', 'spectator')
];

/** Everything the room page fetches. `pollHandler` overrides the poll route. */
async function mockBackend(page, { r = room(), members = [member(1, 100, 'Host'), member(2, 101, 'Bee')], state = { v: 1, voice: [], game: null }, pollHandler } = {}) {
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (x) => x.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: r, members, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**',
		pollHandler ?? ((x) => x.fulfill({ json: { ok: true, cursor: 0, events: [], room: r, members, state } }))
	);
}

/** The switch endpoint, echoing back the room/members it would have written. */
function mockSwitch(page, { room: r, members, onSend } = {}) {
	return page.route('**/api/rooms/*/game-type', (x) => {
		onSend?.(x.request().postDataJSON());
		x.fulfill({
			json: { ok: true, state: { v: 2, voice: [], game: null }, room: r, members, reseated: { promoted: 0, demoted: 0 } }
		});
	});
}

test('host switches an underfilled thief lobby to chess', async ({ page }) => {
	await mockBackend(page);
	let sent = null;
	await mockSwitch(page, { room: CHESS, onSend: (b) => (sent = b) });

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	await expect(page.locator('.chip--accent')).toHaveText('🕵️ Thief Finder');
	await expect(page.getByText('Needs at least 3 players.')).toBeVisible();

	// no Switch button until the pick actually differs from the room
	await expect(page.getByRole('button', { name: 'Switch' })).toHaveCount(0);
	await page.getByLabel('Game', { exact: true }).selectOption('chess');
	await page.getByRole('button', { name: 'Switch' }).click();

	expect(sent).toEqual({ gameType: 'chess', drawsTotal: 5 });
	// the POST response alone updates the view — no poll round trip needed
	await expect(page.locator('.chip--accent')).toHaveText('♟️ Chess');
	await expect(page.getByText('Needs exactly 2 players.')).toBeVisible();
});

test('lobby previews how many players a switch re-seats', async ({ page }) => {
	await mockBackend(page, { members: [1, 2, 3, 4, 5].map((i) => member(i, 99 + i, `P${i}`)) });
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();

	await page.getByLabel('Game', { exact: true }).selectOption('chess');
	await expect(page.getByText('3 players will become spectators.')).toBeVisible();

	await page.getByLabel('Game', { exact: true }).selectOption('ludo'); // seats 4
	await expect(page.getByText('1 player will become spectator.')).toBeVisible();
});

test('spectators are promoted back when the capacity grows', async ({ page }) => {
	// the reverse case: a chess room that filled up now wants Thief Finder
	await mockBackend(page, {
		r: CHESS,
		members: [
			member(1, 100, 'Host'), member(2, 101, 'Bee'),
			member(3, 102, 'Cee', 'spectator'), member(4, 103, 'Dee', 'spectator'),
			member(5, 104, 'Eee', 'spectator')
		]
	});
	await page.goto('/room/1');
	await page.getByLabel('Game', { exact: true }).selectOption('thief_finder');
	await expect(page.getByText('3 spectators will join as players.')).toBeVisible();
	await expect(page.getByLabel('Number of draws')).toBeVisible();
});

test('re-seated roles arrive with the switch response, not a later poll', async ({ page }) => {
	// the poll NEVER learns about the switch here — only the POST response can
	await mockBackend(page, { members: FOUR });
	await mockSwitch(page, { room: CHESS, members: RESEATED });

	await page.goto('/room/1');
	await expect(page.locator('.chip--green')).toHaveCount(4);

	await page.getByLabel('Game', { exact: true }).selectOption('chess');
	await page.getByRole('button', { name: 'Switch' }).click();

	await expect(page.locator('.chip--green')).toHaveCount(2);
	await expect(page.getByText('spectator')).toHaveCount(2);
	await expect(page.getByText('Needs exactly 2 players. 2 players ready.')).toBeVisible();
});

test('a poll held open across the switch does not revert it', async ({ page }) => {
	// room/members have no version number the way `state` does, so a poll that
	// STARTED before the switch would otherwise land after it and undo the change.
	let release = null;
	let polls = 0;
	const stale = { ok: true, cursor: 0, events: [], room: room(), members: FOUR, state: { v: 1, voice: [], game: null } };
	await mockBackend(page, {
		members: FOUR,
		pollHandler: async (x) => {
			if (++polls === 2) await new Promise((r) => (release = r)); // hold it open
			await x.fulfill({ json: stale });
		}
	});
	await mockSwitch(page, { room: CHESS, members: RESEATED });

	await page.goto('/room/1');
	await expect(page.locator('.chip--accent')).toHaveText('🕵️ Thief Finder');
	await expect.poll(() => polls, { timeout: 8000 }).toBeGreaterThanOrEqual(2);

	await page.getByLabel('Game', { exact: true }).selectOption('chess');
	await page.getByRole('button', { name: 'Switch' }).click();
	await expect(page.locator('.chip--accent')).toHaveText('♟️ Chess');

	release?.(); // the stale poll lands — it must not undo the switch
	await page.waitForTimeout(1200);
	await expect(page.locator('.chip--accent')).toHaveText('♟️ Chess');
	await expect(page.locator('.chip--green')).toHaveCount(2);
});

test('play again as another game, from the final leaderboard', async ({ page }) => {
	await mockBackend(page, {
		r: room({ gameType: 'chess', status: 'finished', drawsTotal: 0 }),
		state: { v: 1, voice: [], game: { type: 'chess', result: 'w' } }
	});
	let sent = null;
	await mockSwitch(page, { room: room({ gameType: 'ludo', drawsTotal: 0 }), onSend: (b) => (sent = b) });

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: '🏆 Final leaderboard' })).toBeVisible();

	const go = page.getByRole('button', { name: 'Play again as…' });
	await expect(go).toBeDisabled(); // defaults to the current game
	await page.getByLabel('Game to play next').selectOption('ludo');
	await expect(go).toBeEnabled();
	await go.click();

	expect(sent).toEqual({ gameType: 'ludo' });
	// one call: back to the lobby, now a Ludo room
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	await expect(page.locator('.chip--accent')).toHaveText('🎲 Ludo');
});

test('non-host sees the game but no switcher', async ({ page }) => {
	await mockBackend(page, { r: room({ hostUid: 999, hostName: 'Someone' }) });
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	await expect(page.locator('.chip--accent')).toHaveText('🕵️ Thief Finder');
	await expect(page.getByLabel('Game', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Switch' })).toHaveCount(0);
});

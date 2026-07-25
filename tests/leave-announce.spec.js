import { test, expect } from '@playwright/test';

/**
 * Someone leaving is announced to everyone still in the room.
 *
 * The server has always written a `member-left` system event; nothing rendered
 * it, so a player vanishing from the roster was the only clue. These cases also
 * pin the ORDERING problem that comes with it: one leave can write three system
 * events in a row (round abandoned → host handed on → member left), and the
 * notice slot used to keep only whichever arrived last.
 */

const ME = { uid: 100, name: 'Host' };
const room = (over = {}) => ({
	id: 1, name: 'Leave Test', gameType: 'chess', status: 'lobby',
	hostUid: 100, hostName: 'Host', maxPlayers: 8, drawsTotal: 0, ...over
});
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Host', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Bee', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 3, uid: 102, name: 'Cat', status: 'accepted', role: 'player', score: 0, online: true }
];
const STATE = { v: 1, voice: [], game: null };

/**
 * Serve the room, then hand over `events` once `arm()` is called — the same way
 * the safety poll delivers what the leave endpoint wrote.
 */
async function mockRoom(page, { events, r = room(), members = MEMBERS }) {
	const box = { armed: false };
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (x) => x.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: r, members, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({
			json: {
				ok: true,
				cursor: box.armed ? events[events.length - 1].id : 0,
				events: box.armed ? events : [],
				room: box.armed && box.room ? box.room : r,
				members,
				state: STATE
			}
		})
	);
	return box;
}

test('a member leaving is announced to the room', async ({ page }) => {
	const box = await mockRoom(page, {
		events: [{ id: 9, type: 'system', senderUid: 101, payload: { kind: 'member-left', uid: 101 } }]
	});

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	box.armed = true;

	await expect(page.locator('.room-notice')).toContainText('Bee has left the room', { timeout: 8000 });
});

test('a leaving host is announced as BOTH the departure and the handover', async ({ page }) => {
	// exactly what POST /leave writes when the host walks out of a lobby
	const box = await mockRoom(page, {
		events: [
			{ id: 9, type: 'system', senderUid: 101, payload: { kind: 'host-changed', uid: 100 } },
			{ id: 10, type: 'system', senderUid: 101, payload: { kind: 'member-left', uid: 101 } }
		],
		r: room({ hostUid: 101, hostName: 'Bee' })
	});
	box.room = room({ hostUid: 100 });

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	box.armed = true;

	// the handover lands first…
	await expect(page.locator('.room-notice')).toContainText('You are now the host', { timeout: 8000 });
	// …and the departure is NOT swallowed by it, which is what a single slot did
	await expect(page.locator('.room-notice')).toContainText('Bee has left the room', { timeout: 8000 });
});

test('a player leaving mid-game is announced once, with the reason', async ({ page }) => {
	const box = await mockRoom(page, {
		events: [
			{ id: 9, type: 'system', senderUid: 101, payload: { kind: 'game-abandoned', uid: 101 } },
			{ id: 10, type: 'system', senderUid: 101, payload: { kind: 'member-left', uid: 101 } }
		]
	});

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();

	// Record every announcement the room ever shows. A point-in-time assertion
	// can't tell "suppressed" from "queued behind the current one" — the generic
	// message would simply take the slot later and still be gone by the end.
	await page.evaluate(() => {
		window.__notices = [];
		const seen = () => {
			const t = document.querySelector('.room-notice')?.textContent?.trim();
			if (t && t !== window.__notices.at(-1)) window.__notices.push(t);
		};
		new MutationObserver(seen).observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true
		});
		seen();
	});
	box.armed = true;

	// the richer message wins — the bare "has left the room" would only repeat it
	await expect(page.locator('.room-notice')).toContainText('left mid-game', { timeout: 8000 });
	// outlast every dwell, so anything queued behind it has had its turn
	await expect(page.locator('.room-notice')).toHaveCount(0, { timeout: 15000 });

	const shown = await page.evaluate(() => window.__notices);
	expect(shown.join(' | ')).toContain('left mid-game');
	expect(shown.join(' | '), 'the generic departure must never be shown too').not.toContain(
		'has left the room'
	);
});

import { test, expect } from '@playwright/test';

/**
 * Chat history has its own endpoint, independent of the event cursor.
 *
 * THIS FILE EXISTS BECAUSE OF A TRAP. Chat used to reach a room only as a side
 * effect of the event replay a client gets when it opens with cursor 0 — there
 * was no GET for messages at all. Persisting the cursor, which is what stops the
 * whole retained log being re-sent (and re-announced) on every open, would
 * therefore have left every reopened room with a SILENTLY EMPTY chat panel.
 * Nothing in the suite covered it: chat-visibility's "history intact" case
 * asserts only that the composer is present, and no other spec reloads a page
 * with messages on screen.
 *
 * So the case that matters here is the boring-looking one: a poll that delivers
 * NO events, and chat on screen anyway.
 */

const ME = { uid: 100, name: 'Host' };
const ROOM = {
	id: 1, name: 'History Test', gameType: 'chess', status: 'lobby',
	hostUid: 100, hostName: 'Host', maxPlayers: 8, drawsTotal: 0
};
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Host', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Bee', status: 'accepted', role: 'player', score: 0, online: true }
];

const msg = (id, text, senderUid = 101) => ({ id, senderUid, text });

/**
 * `history` is the whole archive, oldest-first. The route below serves it the
 * way the real endpoint does: a page ending just before `?before=`, newest page
 * when `before` is 0, plus a `more` flag.
 */
async function mockBackend(page, { history = [], events = [], pageSize = 30 } = {}) {
	const calls = { chat: 0 };
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	// The point of the fixture: the event stream carries nothing.
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({
			json: {
				ok: true,
				cursor: events.length ? events[events.length - 1].id : 0,
				events,
				room: ROOM,
				members: MEMBERS,
				state: { v: 1, voice: [], game: null }
			}
		})
	);
	await page.route('**/api/rooms/*/chat?*', (x) => {
		calls.chat++;
		const before = Number(new URL(x.request().url()).searchParams.get('before')) || 0;
		const upTo = before ? history.filter((m) => m.id < before) : history;
		const messages = upTo.slice(-pageSize);
		x.fulfill({ json: { ok: true, messages, more: upTo.length > messages.length } });
	});
	return calls;
}

test('chat renders from its own endpoint when the event stream delivers nothing', async ({ page }) => {
	await mockBackend(page, { history: [msg(1, 'first'), msg(2, 'second'), msg(3, 'third')] });

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();

	// The regression this guards: with chat coupled to the replay these are absent.
	await expect(page.locator('.chat-msg')).toHaveCount(3);
	await expect(page.locator('.chat-list')).toContainText('third');
});

test('history survives a reload — the case a persisted cursor would have broken', async ({ page }) => {
	await mockBackend(page, { history: [msg(1, 'before reload'), msg(2, 'still here')] });

	await page.goto('/room/1');
	await expect(page.locator('.chat-msg')).toHaveCount(2);

	await page.reload();
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	await expect(page.locator('.chat-msg')).toHaveCount(2);
	await expect(page.locator('.chat-list')).toContainText('still here');
});

test('older messages are fetched, not just revealed, and the button retires when spent', async ({ page }) => {
	// 25 messages against a 20-message render window and a 10-per-page server:
	// the first reveal comes from the buffer, later ones must hit the network.
	const history = Array.from({ length: 25 }, (_, i) => msg(i + 1, `m${i + 1}`));
	const calls = await mockBackend(page, { history, pageSize: 10 });

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();

	// Newest page only: 10 fetched, capped by the 20-message window.
	await expect(page.locator('.chat-msg')).toHaveCount(10);
	expect(calls.chat).toBe(1);

	const older = page.getByRole('button', { name: /older messages/i });
	await older.click();
	await expect(page.locator('.chat-msg')).toHaveCount(20);
	expect(calls.chat).toBe(2); // buffer was empty, so this went to the server

	await older.click();
	await expect(page.locator('.chat-msg')).toHaveCount(25);
	await expect(page.locator('.chat-list')).toContainText('m1');

	// Everything is loaded, so the control must stop offering.
	await expect(older).toHaveCount(0);
});

test('a message arriving live does not evict fetched history', async ({ page }) => {
	// trimChat cuts from the FRONT, which is exactly where fetched history lands.
	const history = Array.from({ length: 12 }, (_, i) => msg(i + 1, `m${i + 1}`));
	await mockBackend(page, {
		history,
		events: [{ id: 99, type: 'chat', senderUid: 101, payload: { text: 'live one' } }]
	});

	await page.goto('/room/1');
	await expect(page.locator('.chat-list')).toContainText('live one');
	await expect(page.locator('.chat-list')).toContainText('m1');
});

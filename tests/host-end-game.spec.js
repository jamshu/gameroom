import { test, expect } from '@playwright/test';

/**
 * The host's mid-game escape hatch and the seat controls it exists to enable.
 *
 * A long chess or ludo game used to be a one-way street: the only exits were
 * playing it out or a seated player walking away and dropping the round for
 * everyone. Ending the round is what makes the rest reachable — you can only
 * re-seat people, remove someone or switch game from a lobby, because
 * `game.players` is frozen at start and never reconciled.
 *
 * Driven off mocked API responses, like game-switch.spec.js (CSR-only app, so
 * page.route owns its whole world).
 */

const ME = { uid: 100, name: 'Host' };

const room = (over = {}) => ({
	id: 1, name: 'End Test', gameType: 'chess', status: 'playing',
	hostUid: 100, hostName: 'Host', maxPlayers: 8, drawsTotal: 0, ...over
});
const member = (id, uid, name, role = 'player') =>
	({ id, uid, name, status: 'accepted', role, score: 0, online: true });

const PLAYING_GAME = {
	type: 'chess',
	players: { w: 100, b: 101 },
	fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
	moves: [],
	result: null,
	clock: { w: 600000, b: 600000, ticking: null }
};
const THREE = [
	member(1, 100, 'Host'), member(2, 101, 'Bee'), member(3, 102, 'Cee', 'spectator')
];

/** Everything the room page fetches. `pollHandler` overrides the poll route. */
async function mockBackend(page, { r = room(), members = THREE, state = { v: 1, voice: [], game: PLAYING_GAME }, pollHandler } = {}) {
	page.on('dialog', (d) => d.accept()); // ending a round asks for confirmation
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: r, members, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**',
		pollHandler ?? ((x) => x.fulfill({ json: { ok: true, cursor: 0, events: [], room: r, members, state } }))
	);
}

test('host ends a game in progress and the room lands back in the lobby', async ({ page }) => {
	let ended = false;
	const LOBBY = room({ status: 'lobby' });
	await mockBackend(page, {
		// after the POST the poll must agree, or the next tick would drag the board back
		pollHandler: (x) =>
			x.fulfill({
				json: {
					ok: true, cursor: 0, events: [],
					room: ended ? LOBBY : room(),
					members: THREE,
					state: { v: ended ? 2 : 1, voice: [], game: ended ? null : PLAYING_GAME }
				}
			})
	});
	await page.route('**/api/rooms/*/end', (x) => {
		ended = true;
		// the real route echoes the post-reset state; room/members ride the roster push
		x.fulfill({ json: { ok: true, state: { v: 2, voice: [], game: null } } });
	});

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible({ timeout: 8000 });

	await page.getByRole('button', { name: 'End game' }).click();

	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible({ timeout: 8000 });
	await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
});

test('only the host sees End game, and only while a game is running', async ({ page }) => {
	await mockBackend(page, { r: room({ hostUid: 999, hostName: 'Someone' }) });
	await page.goto('/room/1');
	await expect(page.getByRole('button', { name: 'Leave' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'End game' })).toHaveCount(0);
});

test('End game is absent in a lobby — there is nothing to end', async ({ page }) => {
	await mockBackend(page, { r: room({ status: 'lobby' }), state: { v: 1, voice: [], game: null } });
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'End game' })).toHaveCount(0);
});

test('the whole room is told the round was cut short', async ({ page }) => {
	// a non-host: the board simply disappearing looks exactly like a game that
	// finished normally, so the announcement is the only thing carrying the reason
	let armed = false;
	await mockBackend(page, {
		r: room({ hostUid: 101, hostName: 'Bee' }),
		pollHandler: (x) =>
			x.fulfill({
				json: {
					ok: true,
					cursor: armed ? 9 : 0,
					events: armed
						? [{ id: 9, type: 'system', senderUid: 101, payload: { kind: 'game-ended' } }]
						: [],
					room: armed ? room({ status: 'lobby', hostUid: 101, hostName: 'Bee' }) : room({ hostUid: 101, hostName: 'Bee' }),
					members: THREE,
					state: { v: armed ? 2 : 1, voice: [], game: armed ? null : PLAYING_GAME }
				}
			})
	});

	await page.goto('/room/1');
	await expect(page.locator('.board')).toBeVisible({ timeout: 8000 });
	armed = true;

	await expect(page.locator('.room-notice')).toContainText('ended the game', { timeout: 8000 });
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
});

/* ---- seat management, which is the point of ending the round ---- */

/** The roles endpoint, echoing back the rows it would have written. */
function mockRoles(page, { room: r = room({ status: 'lobby' }), members, onSend } = {}) {
	return page.route('**/api/rooms/*/roles', (x) => {
		onSend?.(x.request().postDataJSON());
		x.fulfill({ json: { ok: true, room: r, members } });
	});
}

test('host seats a waiting spectator when a seat is free', async ({ page }) => {
	// ludo seats 4, so Cee can come in without anyone stepping down
	const LOBBY = room({ status: 'lobby', gameType: 'ludo' });
	await mockBackend(page, { r: LOBBY, state: { v: 1, voice: [], game: null } });
	let sent = null;
	await mockRoles(page, {
		room: LOBBY,
		members: [member(1, 100, 'Host'), member(2, 101, 'Bee'), member(3, 102, 'Cee')],
		onSend: (b) => (sent = b)
	});

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	await expect(page.getByText('2 of 4 seats taken.')).toBeVisible();

	const ceeRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Cee$/ }) });
	await ceeRow.locator('.kebab > summary').click();
	await ceeRow.getByRole('button', { name: /Make player/ }).click();

	expect(sent).toEqual({ memberId: 3, role: 'player' });
	// no swap picker — there was room
	await expect(page.getByText('Seats are full')).toHaveCount(0);
	await expect(page.locator('.chip--green')).toHaveCount(3);
});

test('a full chess table asks who steps down before seating anyone', async ({ page }) => {
	const LOBBY = room({ status: 'lobby' });
	await mockBackend(page, { r: LOBBY, state: { v: 1, voice: [], game: null } });
	let sent = null;
	await mockRoles(page, {
		// the swap the host chose: Cee in, Bee out
		members: [member(1, 100, 'Host'), member(2, 101, 'Bee', 'spectator'), member(3, 102, 'Cee')],
		onSend: (b) => (sent = b)
	});

	await page.goto('/room/1');
	await expect(page.getByText('2 of 2 seats taken.')).toBeVisible();

	const ceeRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Cee$/ }) });
	await ceeRow.locator('.kebab > summary').click();
	await ceeRow.getByRole('button', { name: /Make player/ }).click();

	// nothing was posted yet — a full table needs the host to name the substitution
	expect(sent).toBeNull();
	await expect(page.getByText('Seats are full')).toBeVisible();

	await page.getByRole('button', { name: 'Swap out Bee' }).click();
	expect(sent).toEqual({ memberId: 3, role: 'player', demoteMemberId: 2 });

	// both chips flip off the one response
	const beeRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Bee$/ }) });
	await expect(beeRow.locator('.chip--green')).toHaveCount(0);
	await expect(ceeRow.locator('.chip--green')).toHaveText('player');
	await expect(page.getByText('Seats are full')).toHaveCount(0);
});

test('the host can sit out to free their own seat', async ({ page }) => {
	// the common chess case: the host wants to let two others play
	const LOBBY = room({ status: 'lobby' });
	await mockBackend(page, { r: LOBBY, state: { v: 1, voice: [], game: null } });
	let sent = null;
	await mockRoles(page, {
		members: [member(1, 100, 'Host', 'spectator'), member(2, 101, 'Bee'), member(3, 102, 'Cee', 'spectator')],
		onSend: (b) => (sent = b)
	});

	await page.goto('/room/1');
	const myRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Host$/ }) });
	// the seat toggle is the ONE host control that appears on the host's own row
	await expect(myRow.getByRole('button', { name: /Make host/ })).toHaveCount(0);
	await expect(myRow.getByRole('button', { name: 'Remove' })).toHaveCount(0);

	await myRow.locator('.kebab > summary').click();
	await myRow.getByRole('button', { name: /Make spectator/ }).click();
	expect(sent).toEqual({ memberId: 1, role: 'spectator' });

	// seat freed, and the host keeps the room controls
	await expect(page.getByText('1 of 2 seats taken.')).toBeVisible();
	await expect(myRow.locator('.chip--amber')).toHaveText('host');
	await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
});

test('a non-host sees no seat controls', async ({ page }) => {
	await mockBackend(page, {
		r: room({ status: 'lobby', hostUid: 101, hostName: 'Bee' }),
		state: { v: 1, voice: [], game: null }
	});
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	await expect(page.getByRole('button', { name: /Make player/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Make spectator/ })).toHaveCount(0);
});

test('a seat change is announced, so the demoted player finds out', async ({ page }) => {
	let armed = false;
	await mockBackend(page, {
		r: room({ status: 'lobby', hostUid: 101, hostName: 'Bee' }),
		pollHandler: (x) =>
			x.fulfill({
				json: {
					ok: true,
					cursor: armed ? 9 : 0,
					events: armed
						? [{
							id: 9, type: 'system', senderUid: 101,
							payload: { kind: 'role-changed', uid: 102, role: 'player', demotedUid: 100 }
						}]
						: [],
					room: room({ status: 'lobby', hostUid: 101, hostName: 'Bee' }),
					members: armed
						? [member(1, 100, 'Host', 'spectator'), member(2, 101, 'Bee'), member(3, 102, 'Cee')]
						: THREE,
					state: { v: 1, voice: [], game: null }
				}
			})
	});

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	armed = true;

	// I'm the one who lost the seat — the chip flipping in a list isn't enough
	await expect(page.locator('.room-notice')).toContainText('You are now a spectator', { timeout: 8000 });
});

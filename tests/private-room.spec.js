import { test, expect } from '@playwright/test';

/**
 * Private rooms: a fixed guest list, visible to nobody else, and no join request
 * to approve — being on the list IS the approval.
 *
 * Mocked API responses throughout, like game-switch.spec.js. The visibility
 * filtering itself is an Odoo domain and is covered by room-check's browseDomain
 * cases; what's asserted here is the client half — that the create form sends the
 * right thing, the chips render, and the host's guest-list controls are host-only.
 */

const ME = { uid: 100, name: 'Host' };

const room = (over = {}) => ({
	id: 1, name: 'Private Test', gameType: 'chess', status: 'lobby',
	hostUid: 100, hostName: 'Host', maxPlayers: 8, drawsTotal: 0, visibility: 'private', ...over
});
const member = (id, uid, name, role = 'player') =>
	({ id, uid, name, status: 'accepted', role, score: 0, online: true });
const MEMBERS = [member(1, 100, 'Host'), member(2, 101, 'Bee')];
const STATE = { v: 1, voice: [], game: null };

const DIRECTORY = [
	{ uid: 101, name: 'Bee' },
	{ uid: 102, name: 'Cee' },
	{ uid: 103, name: 'Dee' }
];

async function mockAuth(page) {
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (x) => x.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
}

/** The user directory. `onSearch` sees every query that actually reaches it. */
async function mockUserSearch(page, { onSearch, users = DIRECTORY, delayMs = 0 } = {}) {
	await page.route('**/api/users/search**', async (x) => {
		const q = new URL(x.request().url()).searchParams.get('q') || '';
		onSearch?.(q);
		if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
		await x.fulfill({
			json: { ok: true, users: users.filter((u) => u.name.toLowerCase().includes(q.toLowerCase())) }
		});
	});
}

/* ---------------------------------- browse ---------------------------------- */

async function mockHome(page, { rooms = [], mine = [] } = {}) {
	await mockAuth(page);
	await page.route('**/api/rooms/mine', (x) => x.fulfill({ json: { ok: true, rooms: mine } }));
	await page.route(/\/api\/rooms\?/, (x) => x.fulfill({ json: { ok: true, rooms } }));
}

test('the browse list marks private rooms and leaves public ones plain', async ({ page }) => {
	await mockHome(page, {
		rooms: [
			{ id: 1, name: 'Friends only', gameType: 'chess', status: 'lobby', hostName: 'Host', maxPlayers: 8, visibility: 'private' },
			{ id: 2, name: 'Open table', gameType: 'ludo', status: 'lobby', hostName: 'Bee', maxPlayers: 8, visibility: 'public' }
		]
	});
	await page.goto('/');

	const priv = page.locator('.room-row', { hasText: 'Friends only' });
	const open = page.locator('.room-row', { hasText: 'Open table' });
	await expect(priv.getByText('🔒 private')).toBeVisible();
	await expect(open.getByText('🔒 private')).toHaveCount(0);
});

/* --------------------------------- creating --------------------------------- */

test('creating a private room sends the visibility and the picked guests', async ({ page }) => {
	await mockHome(page);
	await mockUserSearch(page);
	let sent = null;
	await page.route('**/api/rooms', (x) => {
		if (x.request().method() !== 'POST') return x.fallback();
		sent = x.request().postDataJSON();
		x.fulfill({ json: { ok: true, roomId: 7 } });
	});
	// the create flow navigates into the room; stub just enough to land there
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: room({ id: 7 }), members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({ json: { ok: true, cursor: 0, events: [], room: room({ id: 7 }), members: MEMBERS, state: STATE } })
	);
	await page.route('**/api/rooms/*/invites', (x) => x.fulfill({ json: { ok: true, allowed: [] } }));

	await page.goto('/');
	await page.getByRole('button', { name: '+ New room' }).click();
	await page.getByLabel('Room name').fill('Friends only');

	// the picker only appears once the room is marked private
	await expect(page.getByLabel('Search people by name')).toHaveCount(0);
	await page.getByText('🔒 Private room').click();
	const search = page.getByLabel('Search people by name');
	await expect(search).toBeVisible();

	await search.fill('Cee');
	await page.getByRole('button', { name: 'Cee' }).click();
	await expect(page.locator('.picked')).toHaveText(/Cee/);

	await page.getByRole('button', { name: 'Create room' }).click();
	expect(sent).toMatchObject({ name: 'Friends only', visibility: 'private', allowedUids: [102] });
});

test('a public room still posts visibility public and no guests', async ({ page }) => {
	await mockHome(page);
	let sent = null;
	await page.route('**/api/rooms', (x) => {
		if (x.request().method() !== 'POST') return x.fallback();
		sent = x.request().postDataJSON();
		x.fulfill({ json: { ok: true, roomId: 7 } });
	});
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: room({ id: 7, visibility: 'public' }), members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({ json: { ok: true, cursor: 0, events: [], room: room({ id: 7, visibility: 'public' }), members: MEMBERS, state: STATE } })
	);

	await page.goto('/');
	await page.getByRole('button', { name: '+ New room' }).click();
	await page.getByLabel('Room name').fill('Open table');
	await page.getByRole('button', { name: 'Create room' }).click();

	expect(sent).toMatchObject({ visibility: 'public', allowedUids: [] });
});

/* ------------------------------- the picker --------------------------------- */

test('the picker waits for two characters and ignores a stale response', async ({ page }) => {
	const queries = [];
	await mockHome(page);
	// the first (slow) search must not land on top of the second
	await mockUserSearch(page, {
		onSearch: (q) => queries.push(q),
		delayMs: 900
	});

	await page.goto('/');
	await page.getByRole('button', { name: '+ New room' }).click();
	await page.getByText('🔒 Private room').click();
	const search = page.getByLabel('Search people by name');

	await search.fill('C');
	await page.waitForTimeout(700); // past the 400ms debounce
	expect(queries).toEqual([]); // one character never reaches the server

	await search.fill('Cee');
	await page.waitForTimeout(700);
	await search.fill('Dee');
	await expect(page.getByRole('button', { name: 'Dee' })).toBeVisible({ timeout: 8000 });
	// the in-flight 'Cee' response resolves after 'Dee' — it must not reappear
	await page.waitForTimeout(1200);
	await expect(page.getByRole('button', { name: 'Cee' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Dee' })).toBeVisible();
});

/* ------------------------------ the guest list ------------------------------ */

async function mockRoom(page, { r = room(), members = MEMBERS, allowed = [], onInvite } = {}) {
	await mockAuth(page);
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: r, members, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({ json: { ok: true, cursor: 0, events: [], room: r, members, state: STATE } })
	);
	await page.route('**/api/rooms/*/invites', (x) => {
		if (x.request().method() === 'POST') {
			const body = x.request().postDataJSON();
			onInvite?.(body);
			const next = body.action === 'add'
				? [...allowed, DIRECTORY.find((u) => u.uid === body.uid)]
				: allowed.filter((u) => u.uid !== body.uid);
			return x.fulfill({ json: { ok: true, allowed: next } });
		}
		x.fulfill({ json: { ok: true, allowed } });
	});
}

test('the host manages the guest list from the lobby', async ({ page }) => {
	let sent = null;
	await mockRoom(page, {
		allowed: [{ uid: 100, name: 'Host' }, { uid: 101, name: 'Bee' }],
		onInvite: (b) => (sent = b)
	});
	await mockUserSearch(page);

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: '🔒 Invited players (2)' })).toBeVisible();

	// the host is on their own list — the room would vanish from their browse page
	// otherwise — and can't uninvite themselves
	const myRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Host$/ }) });
	await expect(myRow.getByRole('button', { name: 'Uninvite' })).toHaveCount(0);

	const beeRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Bee$/ }) }).last();
	await beeRow.getByRole('button', { name: 'Uninvite' }).click();
	expect(sent).toEqual({ uid: 101, action: 'remove' });
	await expect(page.getByRole('heading', { name: '🔒 Invited players (1)' })).toBeVisible();

	await page.getByLabel('Search people by name').fill('Cee');
	await page.getByRole('button', { name: 'Cee' }).click();
	expect(sent).toEqual({ uid: 102, action: 'add' });
});

test('the guest list is host-only and absent from public rooms', async ({ page }) => {
	await mockRoom(page, { r: room({ hostUid: 101, hostName: 'Bee' }), allowed: [] });
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	// a non-host sees the padlock but never the guest list
	await expect(page.getByTitle('Invite only')).toBeVisible();
	await expect(page.getByRole('heading', { name: /Invited players/ })).toHaveCount(0);
});

test('a public room shows neither the padlock nor the guest list', async ({ page }) => {
	await mockRoom(page, { r: room({ visibility: 'public' }) });
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	await expect(page.getByTitle('Invite only')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: /Invited players/ })).toHaveCount(0);
});

test('someone not on the list gets turned away, and stops asking', async ({ page }) => {
	// they already have the URL — browse never showed them the room
	await mockAuth(page);
	let detailCalls = 0;
	await page.route(/\/api\/rooms\/\d+$/, (x) => {
		detailCalls++;
		x.fulfill({ status: 403, json: { ok: false, error: 'This room is private', code: 'private' } });
	});

	await page.goto('/room/1');
	await expect(page.getByText('This room is private')).toBeVisible();
	// no half-rendered room behind the message, and no roster of who's inside
	await expect(page.getByRole('heading', { name: 'Lobby' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Request to join' })).toHaveCount(0);

	// the 5s detail poll would never succeed — it must have been stopped
	const after = detailCalls;
	await page.waitForTimeout(6000);
	expect(detailCalls).toBe(after);
});

/* --------------------------------- joining ---------------------------------- */

test('an invited player joins straight in, with no approval to wait for', async ({ page }) => {
	await mockAuth(page);
	// I'm on the list but not yet a member row
	const guest = { uid: 102, name: 'Cee' };
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: guest } }));
	let joined = false;
	await page.route('**/api/rooms/mine', (x) => x.fulfill({ json: { ok: true, rooms: [] } }));
	await page.route(/\/api\/rooms\?/, (x) =>
		x.fulfill({
			json: {
				ok: true,
				rooms: [{ id: 1, name: 'Friends only', gameType: 'chess', status: 'lobby', hostName: 'Host', maxPlayers: 8, visibility: 'private' }]
			}
		})
	);
	await page.route('**/api/rooms/*/join', (x) => {
		joined = true;
		x.fulfill({ json: { ok: true, status: 'accepted' } }); // private → accepted, not pending
	});
	const withGuest = [...MEMBERS, member(3, 102, 'Cee', 'spectator')];
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: room(), members: withGuest, me: { status: 'accepted', role: 'spectator' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({ json: { ok: true, cursor: 0, events: [], room: room(), members: withGuest, state: STATE } })
	);

	await page.goto('/');
	await page.locator('.room-row', { hasText: 'Friends only' }).getByRole('button', { name: 'Join' }).click();

	expect(joined).toBe(true);
	// straight into the lobby — never the "waiting for the host to accept" card
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible({ timeout: 8000 });
	await expect(page.getByText('Waiting for the host to accept')).toHaveCount(0);
});

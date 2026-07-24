import { test, expect } from '@playwright/test';

/**
 * Passing the room to another player, so the original host can leave without
 * taking the room with them. Host is a ROOM role, not a seat — the point of
 * these cases is that the controls move and nothing else does.
 */

const ME = { uid: 100, name: 'Host' };
const room = (over = {}) => ({
	id: 1, name: 'Host Test', gameType: 'chess', status: 'lobby',
	hostUid: 100, hostName: 'Host', maxPlayers: 8, drawsTotal: 0, ...over
});
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Host', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Bee', status: 'accepted', role: 'player', score: 0, online: true }
];
const STATE = { v: 1, voice: [], game: null };

async function mockBackend(page, { r = room() } = {}) {
	page.on('dialog', (d) => d.accept()); // the handover asks for confirmation
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (x) => x.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: r, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({ json: { ok: true, cursor: 0, events: [], room: r, members: MEMBERS, state: STATE } })
	);
}

test('host passes the room to another member and loses the controls', async ({ page }) => {
	await mockBackend(page);
	let sent = null;
	// the endpoint echoes the room back with the new host, as the real one does
	await page.route('**/api/rooms/*/host', (x) => {
		sent = x.request().postDataJSON();
		x.fulfill({ json: { ok: true, room: room({ hostUid: 101, hostName: 'Bee' }), members: MEMBERS } });
	});

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();

	// host controls are present, and the host badge is on me
	await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
	// scoped to the name cell: a bare hasText:'Host' also matches the other row's
	// "Make host" button, since Playwright substring-matches case-insensitively
	const myRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Host$/ }) });
	await expect(myRow.locator('.chip--amber')).toHaveText('host');
	// no handover button against myself
	await expect(myRow.getByRole('button', { name: /Make host/ })).toHaveCount(0);

	await page.getByRole('button', { name: /Make host/ }).click();
	expect(sent).toEqual({ uid: 101 });

	// the POST response alone moves the badge — no poll round trip needed
	const beeRow = page.locator('.member-row', { has: page.locator('.member-name', { hasText: /^Bee$/ }) });
	await expect(beeRow.locator('.chip--amber')).toHaveText('host');
	// and the controls are gone for the ex-host
	await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Make host/ })).toHaveCount(0);
	await page.screenshot({ path: 'test-results/host-transferred.png' });
});

test('a non-host sees no handover controls', async ({ page }) => {
	await mockBackend(page, { r: room({ hostUid: 101, hostName: 'Bee' }) });
	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();

	await expect(page.getByRole('button', { name: /Make host/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
});

test('a host handover is announced to the room', async ({ page }) => {
	// deliver the system event the server writes, as the poll would
	let armed = false;
	page.on('dialog', (d) => d.accept());
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/realtime/token**', (x) => x.fulfill({ status: 501, json: { error: 'off' } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: room(), members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({
			json: {
				ok: true,
				cursor: armed ? 9 : 0,
				events: armed
					? [{ id: 9, type: 'system', senderUid: 101, payload: { kind: 'host-changed', uid: 100 } }]
					: [],
				room: armed ? room({ hostUid: 100 }) : room({ hostUid: 101, hostName: 'Bee' }),
				members: MEMBERS,
				state: STATE
			}
		})
	);

	await page.goto('/room/1');
	await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
	armed = true;

	// promoted mid-session: the board doesn't change, so without the banner you'd
	// only notice by spotting controls that weren't there before
	await expect(page.locator('.room-notice')).toContainText('You are now the host', { timeout: 8000 });
	await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
});

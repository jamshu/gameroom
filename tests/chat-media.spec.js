import { test, expect } from '@playwright/test';

/**
 * Photos and voice clips in room chat. Fully mocked (the app is CSR-only), so
 * this exercises the parts that don't need Odoo: the client resize + upload
 * contract, the optimistic bubble, and — the part most likely to regress — that
 * a media message arriving from the POLL renders from the room media proxy.
 */

const ME = { uid: 100, name: 'Host' };
const ROOM = {
	id: 1, name: 'Media Test', gameType: 'chess', status: 'lobby',
	hostUid: 100, hostName: 'Host', maxPlayers: 8, drawsTotal: 0
};
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Host', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Bee', status: 'accepted', role: 'player', score: 0, online: true }
];

// 1x1 red PNG — enough for the canvas resize path to produce a JPEG.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

async function mockBackend(page, { events = [] } = {}) {
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room: ROOM, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
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
	// the proxy that serves attachment bytes — any image will do
	await page.route('**/api/rooms/*/media/**', (x) =>
		x.fulfill({ contentType: 'image/png', body: PNG })
	);
}

test('sending a photo uploads a resized JPEG and shows the bubble immediately', async ({ page }) => {
	await mockBackend(page);
	let sent = null;
	await page.route('**/api/rooms/*/chat', (x) => {
		sent = x.request().postDataJSON();
		x.fulfill({ json: { ok: true, id: 501, attId: 77 } });
	});

	await page.goto('/room/1');
	await expect(page.getByPlaceholder('Message…')).toBeVisible();

	// a caption typed before attaching rides along with the photo
	await page.getByPlaceholder('Message…').fill('look at this');
	await page.setInputFiles('input[type=file]', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });

	const bubble = page.locator('.shot img');
	await expect(bubble).toBeVisible();
	await expect(page.getByText('look at this')).toBeVisible();

	await expect.poll(() => sent?.kind).toBe('image');
	expect(sent.mime).toBe('image/jpeg'); // resized client-side, never the raw PNG
	expect(sent.text).toBe('look at this');
	expect(sent.w).toBeGreaterThan(0);
	expect(sent.dataBase64.length).toBeGreaterThan(0);
	expect(sent.dataBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

	// the ack clears the in-flight styling, and the caption box was emptied
	await expect(page.locator('.chat-msg.pending')).toHaveCount(0);
	await expect(page.getByPlaceholder('Message…')).toHaveValue('');
});

test('a failed upload drops the bubble and reports the error', async ({ page }) => {
	await mockBackend(page);
	await page.route('**/api/rooms/*/chat', (x) =>
		x.fulfill({ status: 413, json: { ok: false, error: 'Attachment too large' } })
	);

	await page.goto('/room/1');
	await expect(page.getByPlaceholder('Message…')).toBeVisible();
	await page.setInputFiles('input[type=file]', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });

	await expect(page.getByText('Attachment too large')).toBeVisible();
	await expect(page.locator('.shot img')).toHaveCount(0);
});

test('the empty-chat placeholder posts the greeting for you', async ({ page }) => {
	await mockBackend(page);
	let sent = null;
	await page.route('**/api/rooms/*/chat', (x) => {
		sent = x.request().postDataJSON();
		x.fulfill({ json: { ok: true, id: 501 } });
	});

	await page.goto('/room/1');
	const hi = page.getByRole('button', { name: 'Say hi 👋' });
	await expect(hi).toBeVisible();

	await hi.click();
	expect(sent).toEqual({ text: 'Hi 👋' });

	// posts through the same optimistic path as a typed line: the bubble is there
	// before the ack, the placeholder is gone because the chat is no longer empty,
	// and the composer was never involved
	await expect(page.locator('.chat-bubble')).toHaveText(/Hi 👋/);
	await expect(page.locator('.chat-msg.pending')).toHaveCount(0);
	await expect(hi).toHaveCount(0);
	await expect(page.getByPlaceholder('Message…')).toHaveValue('');
});

test('a greeting that fails to send leaves the placeholder to retry', async ({ page }) => {
	await mockBackend(page);
	await page.route('**/api/rooms/*/chat', (x) =>
		x.fulfill({ status: 500, json: { ok: false, error: 'Chat is unavailable' } })
	);

	await page.goto('/room/1');
	await page.getByRole('button', { name: 'Say hi 👋' }).click();

	await expect(page.getByText('Chat is unavailable')).toBeVisible();
	// the optimistic bubble was rolled back, so the chat is empty again and the
	// button is back rather than the room being left with a phantom message
	await expect(page.locator('.chat-bubble')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Say hi 👋' })).toBeVisible();
});

test('media from another player renders off the room media proxy', async ({ page }) => {
	await mockBackend(page, {
		events: [
			{ id: 601, type: 'chat', senderUid: 101, payload: { kind: 'image', attId: 88, mime: 'image/jpeg', w: 800, h: 600, text: 'my hand' } },
			{ id: 602, type: 'chat', senderUid: 101, payload: { kind: 'voice', attId: 89, mime: 'audio/webm', dur: 7 } },
			{ id: 603, type: 'chat', senderUid: 101, payload: { text: 'and a plain message' } }
		]
	});

	await page.goto('/room/1');

	// the id in the src is what the server ownership check is keyed on
	await expect(page.locator('.shot img')).toHaveAttribute('src', '/api/rooms/1/media/88');
	await expect(page.locator('.chat-list audio')).toHaveAttribute('src', '/api/rooms/1/media/89');
	await expect(page.getByText('0:07')).toBeVisible();
	await expect(page.getByText('my hand')).toBeVisible();
	// text messages are untouched by the payload change
	await expect(page.getByText('and a plain message')).toBeVisible();
});

/**
 * A clip that won't play must SAY so. This is the iPhone bug's second half: the
 * <audio> element had no error handler, media error events don't bubble, and
 * preload="none" means nothing fails until play is pressed — so a WebM/Opus clip
 * an iOS listener can't decode looked like a working player that did nothing.
 */
test('a voice clip that will not play says why instead of failing silently', async ({ page }) => {
	await mockBackend(page, {
		events: [
			{ id: 602, type: 'chat', senderUid: 101, payload: { kind: 'voice', attId: 89, mime: 'audio/webm', dur: 7 } }
		]
	});
	// the attachment is gone — the same shape a stale/foreign attId produces
	await page.route('**/api/rooms/*/media/89', (x) =>
		x.fulfill({ status: 404, json: { ok: false, error: 'Not found' } })
	);

	await page.goto('/room/1');
	const audio = page.locator('.chat-list audio');
	await expect(audio).toHaveAttribute('src', '/api/rooms/1/media/89');
	// preload="none" defers the failure to playback, which is the point — force it
	await audio.evaluate((el) => el.load());

	await expect(page.locator('.clip-err')).toContainText('no longer available');
	await expect(page.locator('.clip-err a')).toHaveAttribute('href', '/api/rooms/1/media/89');
});

test('tapping a photo opens it full-size, and clicking again closes it', async ({ page }) => {
	await mockBackend(page, {
		events: [
			{ id: 601, type: 'chat', senderUid: 101, payload: { kind: 'image', attId: 88, mime: 'image/jpeg', w: 800, h: 600 } }
		]
	});

	await page.goto('/room/1');
	await page.locator('.shot img').click();
	await expect(page.locator('.lightbox img')).toBeVisible();
	await page.locator('.lightbox').click();
	await expect(page.locator('.lightbox')).toHaveCount(0);
});

import { test, expect } from '@playwright/test';

/**
 * The People page: search the user directory, follow/unfollow from results, and
 * review/unfollow the Following list. All state runs through the shared follow
 * store, so a follow made here shows up on in-room member rows too.
 */

const ME = { uid: 100, name: 'Me' };
const DIRECTORY = [
	{ uid: 201, name: 'Alice' },
	{ uid: 202, name: 'Bob' }
];

async function mockBackend(page, { people = [] } = {}) {
	const followingIds = people.map((p) => p.uid);
	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route('**/api/users/search**', (x) => {
		const q = new URL(x.request().url()).searchParams.get('q')?.toLowerCase() || '';
		const users = DIRECTORY.filter((u) => u.name.toLowerCase().includes(q));
		x.fulfill({ json: { ok: true, users } });
	});
	await page.route('**/api/follow', (x) => {
		if (x.request().method() === 'GET') {
			return x.fulfill({ json: { ok: true, following: followingIds, people } });
		}
		return x.fulfill({ json: { ok: true } });
	});
}

test('the Following list renders and unfollow removes a row', async ({ page }) => {
	await mockBackend(page, { people: [{ uid: 201, name: 'Alice' }] });
	await page.goto('/people');
	await expect(page.getByRole('heading', { name: 'Find people' })).toBeVisible();

	const section = page.locator('.card').filter({ hasText: 'Alice' });
	await expect(page.getByRole('heading', { name: /Following \(1\)/ })).toBeVisible();
	await section.getByRole('button', { name: 'Unfollow' }).click();
	await expect(page.getByText('Alice')).toHaveCount(0);
});

test('search a user and follow them', async ({ page }) => {
	await mockBackend(page);
	await page.goto('/people');

	let sent = null;
	await page.route('**/api/follow', (x) => {
		if (x.request().method() === 'POST') {
			sent = x.request().postDataJSON();
			return x.fulfill({ json: { ok: true } });
		}
		return x.fulfill({ json: { ok: true, following: [], people: [] } });
	});

	await page.getByRole('searchbox').fill('Ali');
	const row = page.locator('.person', { hasText: 'Alice' });
	const btn = row.getByRole('button', { name: /Follow/ });
	await expect(btn).toHaveText('+ Follow');
	await btn.click();
	await expect(btn).toHaveText('✓ Following');
	expect(sent).toEqual({ targetUid: 201, action: 'follow' });

	// following them makes them appear in the Following list too
	await expect(page.getByRole('heading', { name: /Following \(1\)/ })).toBeVisible();
});

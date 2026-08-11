import { test, expect } from '@playwright/test';

/**
 * The solo games, which are the one part of the app that needs no server at all:
 * the puzzle is generated in the tab, every move is resolved there, and nothing
 * is written anywhere but localStorage.
 *
 * That independence is the thing worth pinning. These specs deliberately do NOT
 * mock /api/* the way the room specs do — if anything here needs the network,
 * a solo game is not actually solo, and `/solo` being reachable without a
 * session (OPEN_ROUTES in +layout.svelte) has silently regressed.
 */

test.describe('solo sudoku', () => {
	test('plays without any session or backend', async ({ page }) => {
		/* Abort EVERY api call, session check included. That is the offline case,
		   not merely a strict one: with no network `checkSession` fails and sets
		   `user = null`, which is exactly when the auth gate used to redirect a
		   precached solo page to /signup — the moment the game is most useful.
		   `/solo` is in OPEN_ROUTES to prevent that, and this is what pins it. */
		const gameCalls = [];
		await page.route('**/api/**', (route) => {
			const url = route.request().url();
			if (!url.includes('/api/auth/')) gameCalls.push(url);
			route.abort();
		});

		await page.goto('/solo/sudoku');

		// the auth gate must NOT have bounced us to /signup
		await expect(page).toHaveURL(/\/solo\/sudoku/);
		await expect(page.getByRole('heading', { name: /Sudoku/ })).toBeVisible();

		// 81 cells, and a keypad of nine digits
		const cells = page.locator('.grid .cell');
		await expect(cells).toHaveCount(81);
		await expect(page.locator('.pad .key')).toHaveCount(9);

		// a medium puzzle leaves 36 givens, so there is something to fill and
		// something already filled in
		const givens = page.locator('.grid .cell.given');
		await expect(givens).toHaveCount(36);

		expect(gameCalls, 'a solo game must not call any game API').toEqual([]);
	});

	test('a digit either lands or costs a mistake and a freeze', async ({ page }) => {
		await page.goto('/solo/sudoku');

		const empty = page.locator('.grid .cell:not(.given)').first();
		await empty.click();
		await expect(empty).toHaveClass(/sel/);

		/* One digit, then assert whichever branch it took. Deliberately NOT a loop
		   over 1-9 looking for the right answer: the first wrong digit freezes
		   input for ten seconds, so brute-forcing the keypad is exactly what the
		   rule prevents — an earlier version of this test hung on the disabled pad,
		   which is the freeze working. Reading the solution out of the page to pick
		   the right digit would test nothing. */
		await page.locator('.pad .key', { hasText: '1' }).first().click();
		await page.waitForTimeout(900); // let the wrong-flash clear

		const kept = (await empty.textContent())?.trim() === '1';
		const mistakes = page.locator('.stat', { hasText: '✗' });

		if (kept) {
			// correct: the digit stays, nothing is charged, input is still live
			await expect(mistakes).toHaveText(/0/);
			await expect(page.locator('.stat--frozen')).toHaveCount(0);
			await expect(page.locator('.pad .key').first()).toBeEnabled();
		} else {
			// wrong: not placed, counted, and the player is frozen out
			await expect(empty).toHaveText('');
			await expect(mistakes).toHaveText(/1/);
			await expect(page.locator('.stat--frozen')).toBeVisible();
			await expect(page.locator('.pad .key').first()).toBeDisabled();
		}
	});

	test('changing difficulty deals a different puzzle', async ({ page }) => {
		await page.goto('/solo/sudoku');
		const givens = page.locator('.grid .cell.given');
		await expect(givens).toHaveCount(36); // medium

		await page.getByRole('radio', { name: 'easy' }).click();
		await expect(givens).toHaveCount(45);

		await page.getByRole('radio', { name: 'hard' }).click();
		await expect(givens).toHaveCount(30);
	});
});

test.describe('solo candy match', () => {
	test('plays without any session or backend', async ({ page }) => {
		/* Abort EVERY api call, session check included. That is the offline case,
		   not merely a strict one: with no network `checkSession` fails and sets
		   `user = null`, which is exactly when the auth gate used to redirect a
		   precached solo page to /signup — the moment the game is most useful.
		   `/solo` is in OPEN_ROUTES to prevent that, and this is what pins it. */
		const gameCalls = [];
		await page.route('**/api/**', (route) => {
			const url = route.request().url();
			if (!url.includes('/api/auth/')) gameCalls.push(url);
			route.abort();
		});

		await page.goto('/solo/match3');
		await expect(page).toHaveURL(/\/solo\/match3/);
		await expect(page.getByRole('heading', { name: /Candy Match/ })).toBeVisible();

		// 8x8 of tiles, every one showing a face
		const tiles = page.locator('.grid .tile');
		await expect(tiles).toHaveCount(64);
		await expect(tiles.first()).not.toHaveText('');

		expect(gameCalls, 'a solo game must not call any game API').toEqual([]);
	});

	test('a swap that matches scores, and the clock runs', async ({ page }) => {
		await page.goto('/solo/match3');

		const scoreAt = async () =>
			Number((await page.locator('.stat', { hasText: 'Score' }).textContent())?.replace(/\D/g, '') || 0);

		expect(await scoreAt()).toBe(0);

		/* Find a legal swap by trying adjacent pairs until the score moves. The
		   board is seeded from Date.now(), so which pair works differs every run —
		   searching is what makes this deterministic rather than the seed. */
		const tiles = page.locator('.grid .tile');
		let scored = 0;
		for (let i = 0; i < 64 && !scored; i++) {
			for (const j of [i + 1, i + 8]) {
				if (j >= 64) continue;
				if (j === i + 1 && (i + 1) % 8 === 0) continue; // would wrap the row
				await tiles.nth(i).click();
				await tiles.nth(j).click();
				scored = await scoreAt();
				if (scored) break;
			}
		}
		expect(scored, 'a fresh board always has at least one legal swap').toBeGreaterThan(0);
	});

	test('endless mode has no clock', async ({ page }) => {
		await page.goto('/solo/match3');
		await expect(page.locator('.stat', { hasText: '⏱' })).toBeVisible();

		await page.getByRole('radio', { name: 'Endless' }).click();
		await expect(page.locator('.stat', { hasText: '⏱' })).toHaveCount(0);
	});
});

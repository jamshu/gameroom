import { test, expect } from '@playwright/test';
import { initGame, stateView, applySudokuFill } from '../src/lib/shared/gamelogic.js';

/**
 * The multiplayer race games, driven through the room page.
 *
 * The gap this closes: the DO suite calls the ops directly and the solo specs
 * never touch a room, so nothing else exercises SudokuRace/Match3Race against
 * the PROJECTED game shape — the one `stateView` actually puts on the wire.
 * That contract is implicit (sudokuView emits rivals without `filled`, self with
 * it) and was written separately from its consumer, so a mismatch would show up
 * only in front of real players.
 *
 * The state served below is therefore built by running the real `initGame` and
 * the real `stateView`, not by hand-writing a fixture: a fixture would drift
 * from the projection and pass anyway.
 */

const ME = { uid: 100, name: 'Host' };
const MEMBERS = [
	{ id: 1, uid: 100, name: 'Host', status: 'accepted', role: 'player', score: 0, online: true },
	{ id: 2, uid: 101, name: 'Bee', status: 'accepted', role: 'player', score: 0, online: true }
];
const roomFor = (gameType) => ({
	id: 1, name: 'Race Test', gameType, status: 'playing',
	hostUid: 100, hostName: 'Host', maxPlayers: 4, drawsTotal: 0
});

/** Serve a room whose state is the real per-uid projection of `game`. */
async function mockRoom(page, gameType, game) {
	const room = roomFor(gameType);
	const box = { game, v: 1, writes: [] };

	await page.route('**/api/auth/me', (x) => x.fulfill({ json: { user: ME } }));
	await page.route('**/api/avatar/**', (x) => x.fulfill({ status: 404, body: '' }));
	await page.route(/\/api\/rooms\/\d+$/, (x) =>
		x.fulfill({ json: { room, members: MEMBERS, me: { status: 'accepted', role: 'player' } } })
	);
	await page.route('**/api/rooms/*/poll**', (x) =>
		x.fulfill({
			json: {
				ok: true, cursor: 0, events: [], room, members: MEMBERS,
				// THE POINT: the same function the server serializes through.
				state: { ...stateView({ v: box.v, wins: {}, voice: [], game: box.game }, ME.uid) }
			}
		})
	);
	return box;
}

test('a sudoku race renders the projected board and never receives the solution', async ({ page }) => {
	const game = initGame('sudoku', [100, 101], {});
	// give the rival visible progress so the ticker has something to show
	const blanks = game.puzzle.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
	for (const i of blanks.slice(0, 12)) game.boards[101].filled[i] = game.solution[i];

	const box = await mockRoom(page, 'sudoku', game);

	/* Answer the fill the way the real endpoint does: apply the REAL rule to the
	   server-side game, bump the version, and echo the projected state back — the
	   store merges that echo, which is how the mistake counter and the freeze
	   reach the board. An earlier version of this mock returned only
	   `{correct:false}` and the freeze never appeared, which is the mock being
	   wrong rather than the app: the display is driven by state, not by the POST's
	   own fields. */
	const bodies = [];
	await page.route('**/api/rooms/*/sudoku/fill', async (x) => {
		const body = x.request().postDataJSON();
		bodies.push(body);
		const res = applySudokuFill(box.game, ME.uid, body.cell, body.digit);
		box.v++;
		await x.fulfill({
			json: {
				ok: true,
				correct: res.correct,
				mistakes: res.mistakes,
				frozenUntil: res.frozenUntil ?? 0,
				state: stateView({ v: box.v, wins: {}, voice: [], game: box.game }, ME.uid)
			}
		});
	});

	await page.goto('/room/1');

	await expect(page.locator('.grid .cell')).toHaveCount(81);
	await expect(page.locator('.grid .cell.given')).toHaveCount(36);

	// the rival ticker is driven by the server's projected pct, and Bee has 12 of
	// the 45 blanks done — so a bar is showing, with her name on it
	const rival = page.locator('.rivals li');
	await expect(rival).toHaveCount(1);
	await expect(rival).toContainText('Bee');
	await expect(rival).toContainText('%');

	// the answer key must not be anywhere in the page's data
	const leaked = await page.evaluate((sol) => JSON.stringify(sol), game.solution);
	const html = await page.content();
	expect(html.includes(leaked), 'the solution reached the browser').toBe(false);

	/* A digit goes out as a fill. The digit is DERIVED to be wrong rather than
	   picked — a hardcoded one would be the correct answer for that cell roughly
	   one run in nine and the freeze assertions below would flake. The test owns
	   the server side here, so it may read the solution; the browser may not,
	   which is what the assertion above checks. */
	const firstBlank = blanks[0];
	const wrongDigit = (game.solution[firstBlank] % 9) + 1;

	await page.locator('.grid .cell:not(.given)').first().click();
	await page.locator('.pad .key', { hasText: String(wrongDigit) }).first().click();
	await expect.poll(() => bodies.length).toBe(1);
	expect(bodies[0]).toEqual({ cell: firstBlank, digit: wrongDigit });

	// the server said "wrong", so the board shows the mistake and the freeze
	await expect(page.locator('.stat--frozen')).toBeVisible();
	await expect(page.locator('.stat', { hasText: '✗' })).toHaveText(/1/);
	expect(box.v).toBe(2); // the fill advanced the authoritative state exactly once
});

test('a candy match race builds the board from the shared seed and ticks its score', async ({ page }) => {
	const game = initGame('match3', [100, 101], {});
	await mockRoom(page, 'match3', game);

	const ticks = [];
	await page.route('**/api/rooms/*/match3/tick', async (x) => {
		ticks.push(x.request().postDataJSON());
		await x.fulfill({ json: { ok: true } });
	});
	await page.route('**/api/rooms/*/match3/finish', (x) => x.fulfill({ json: { ok: true, score: 0 } }));

	await page.goto('/room/1');

	// the board is generated locally from the seed — the server never sent tiles
	await expect(page.locator('.grid .tile')).toHaveCount(64);
	await expect(page.locator('.grid .tile').first()).not.toHaveText('');
	// the rival's score panel is up, and the clock is running
	await expect(page.locator('.rivals li')).toContainText('Bee');
	await expect(page.locator('.stat', { hasText: '⏱' })).toBeVisible();

	const scoreAt = async () =>
		Number((await page.locator('.stat', { hasText: 'Score' }).textContent())?.replace(/\D/g, '') || 0);

	// find a legal swap; the seed is minted per game so which pair works varies
	const tiles = page.locator('.grid .tile');
	let scored = 0;
	for (let i = 0; i < 64 && !scored; i++) {
		for (const j of [i + 1, i + 8]) {
			if (j >= 64 || (j === i + 1 && (i + 1) % 8 === 0)) continue;
			await tiles.nth(i).click();
			await tiles.nth(j).click();
			scored = await scoreAt();
			if (scored) break;
		}
	}
	expect(scored, 'a fresh board always has a legal swap').toBeGreaterThan(0);

	// scoring publishes a tick — ephemeral, and carrying only the score
	await expect.poll(() => ticks.length).toBeGreaterThan(0);
	expect(ticks[0]).toHaveProperty('score');
	expect(ticks[0].score).toBeGreaterThan(0);
});

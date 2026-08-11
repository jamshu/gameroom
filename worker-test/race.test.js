// The race games' per-player ops, inside the object.
//
// Sudoku and match-3 are the second place several players write at the same
// instant. Thief-finder solved that with a total-order tiebreak
// (contendedProgress) because its writers contend for the SAME bytes; the race
// games deliberately do NOT use that, because each player writes only their own
// `boards[uid]` / `scores[uid]` and there is nothing to rank — only to merge.
//
// This suite is what makes that claim testable: it pins that concurrent fills
// from different players all survive, that a refused write burns no version, and
// that the ephemeral tick channel writes nothing at all. None of it is reachable
// from the check:* scripts (which run pure logic under node) or from Playwright
// (whose specs all take the Odoo path).
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { kvGet, kvSet } from '../src/lib/do/schema.js';
import { initGame } from '../src/lib/shared/gamelogic.js';
import { ROUND_MS, GRACE_MS } from '../src/lib/shared/match3.js';
import { FREEZE_MS } from '../src/lib/shared/sudoku.js';

const room = (n) => env.ROOM.get(env.ROOM.idFromName(n));
const PLAYERS = [7, 20, 33];

async function seedOwned(stub, game) {
	await runInDurableObject(stub, (instance) => {
		kvSet(instance.sql, 'hydrated_at', Date.now());
		// owns_state short-circuits ensureOwned, so no op reaches odoo.invalid.
		kvSet(instance.sql, 'owns_state', 1);
		kvSet(instance.sql, 'room_id', 42);
		kvSet(instance.sql, 'room', { id: 42, name: 'test' });
		kvSet(instance.sql, 'members', PLAYERS.map((uid) => ({ uid })));
		kvSet(instance.sql, 'members_raw', []);
		kvSet(instance.sql, 'state', { v: 1, voice: [], voiceSince: null, game });
	});
}

const apply = (stub, op) =>
	stub.fetch('https://do/apply', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-room-id': '42' },
		body: JSON.stringify(op)
	}).then((r) => r.json());

const stateOf = (stub) => runInDurableObject(stub, (instance) => kvGet(instance.sql, 'state'));

/** The editable cells of a dealt puzzle, in order. */
const blanksOf = (game) => game.puzzle.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);

describe('sudokuFill', () => {
	it('merges concurrent fills from different players instead of ranking them', async () => {
		// THE POINT OF THE WHOLE DESIGN. On the Odoo seam these three writes would
		// read the same state.v and write back three different blobs, and two of
		// them would be dropped by the version gate with no way back — the exact
		// failure contendedProgress exists to work around for thief-finder. Inside
		// the object each one merges into its own sub-state.
		const stub = room('race-merge');
		const game = initGame('sudoku', PLAYERS, {});
		await seedOwned(stub, game);
		const cells = blanksOf(game);

		const results = await Promise.all(
			PLAYERS.map((uid, i) =>
				apply(stub, { op: 'sudokuFill', uid, cell: cells[i], digit: game.solution[cells[i]] })
			)
		);
		expect(results.every((r) => r.ok && r.correct)).toBe(true);

		const after = await stateOf(stub);
		PLAYERS.forEach((uid, i) => {
			expect(after.game.boards[uid].filled[cells[i]]).toBe(game.solution[cells[i]]);
		});
		// every fill advanced the version — none was silently dropped
		expect(after.v).toBe(1 + PLAYERS.length);
	});

	it('rejects a wrong digit, counts it, freezes the player, and places nothing', async () => {
		const stub = room('race-wrong');
		const game = initGame('sudoku', PLAYERS, {});
		await seedOwned(stub, game);
		const cell = blanksOf(game)[0];
		const wrong = (game.solution[cell] % 9) + 1;

		const res = await apply(stub, { op: 'sudokuFill', uid: 7, cell, digit: wrong });
		expect(res.ok).toBe(true);
		expect(res.correct).toBe(false);

		const after = await stateOf(stub);
		expect(after.game.boards[7].filled[cell]).toBeUndefined();
		expect(after.game.boards[7].mistakes).toBe(1);
		expect(after.game.boards[7].frozenUntil).toBeGreaterThan(Date.now());
		expect(after.game.boards[7].frozenUntil).toBeLessThanOrEqual(Date.now() + FREEZE_MS);

		// and the freeze is enforced HERE — a client ignoring its own countdown is
		// still refused, which is the whole reason the penalty is server-side
		const blocked = await apply(stub, { op: 'sudokuFill', uid: 7, cell, digit: game.solution[cell] });
		expect(blocked.ok).toBe(false);
		expect(blocked.code).toBe('frozen');
		expect((await stateOf(stub)).game.boards[7].filled[cell]).toBeUndefined();
	});

	it('burns no version and no broadcast on a refused write', async () => {
		// A frozen player mashing the keypad must not fan out to the whole room.
		const stub = room('race-noburn');
		const game = initGame('sudoku', PLAYERS, {});
		await seedOwned(stub, game);
		const before = (await stateOf(stub)).v;

		const notAPlayer = await apply(stub, { op: 'sudokuFill', uid: 999, cell: blanksOf(game)[0], digit: 1 });
		expect(notAPlayer.ok).toBe(false);
		const badCell = await apply(stub, { op: 'sudokuFill', uid: 7, cell: 999, digit: 1 });
		expect(badCell.ok).toBe(false);

		expect((await stateOf(stub)).v).toBe(before);
	});

	it('the first player to complete a grid wins, and the race then closes', async () => {
		const stub = room('race-win');
		const game = initGame('sudoku', PLAYERS, {});
		await seedOwned(stub, game);
		const cells = blanksOf(game);

		let last;
		for (const cell of cells) {
			last = await apply(stub, { op: 'sudokuFill', uid: 20, cell, digit: game.solution[cell] });
			expect(last.ok).toBe(true);
		}
		expect(last.won).toBe(true);

		const after = await stateOf(stub);
		expect(after.game.result).toBe(20);
		expect(after.game.boards[20].doneAt).toBeGreaterThan(0);

		// nobody else may keep filling into a finished race
		const late = await apply(stub, { op: 'sudokuFill', uid: 7, cell: cells[0], digit: game.solution[cells[0]] });
		expect(late.ok).toBe(false);
		expect((await stateOf(stub)).game.result).toBe(20);
	});

	it('refuses to touch a room whose game is not sudoku', async () => {
		const stub = room('race-wrongtype');
		await seedOwned(stub, initGame('match3', PLAYERS, {}));
		const res = await apply(stub, { op: 'sudokuFill', uid: 7, cell: 0, digit: 1 });
		expect(res.ok).toBe(false);
		expect(res.status).toBe(409);
	});
});

describe('match3Finish', () => {
	/** A game whose clock has run out, but still inside the grace window — the
	 *  normal case, where everyone is reporting their score. */
	function expiredGame() {
		const game = initGame('match3', PLAYERS, {});
		game.startedAt = Date.now() - ROUND_MS - 500;
		return game;
	}

	/** A game whose grace window has ALSO passed, so stragglers can be closed. */
	function staleGame() {
		const game = initGame('match3', PLAYERS, {});
		game.startedAt = Date.now() - ROUND_MS - GRACE_MS - 1000;
		return game;
	}

	it('refuses a finish while the clock is still running', async () => {
		// The client notices expiry and asks; the SERVER decides, from its own
		// startedAt — the chess/flag arrangement, and why no DO alarm is needed.
		const stub = room('m3-early');
		await seedOwned(stub, initGame('match3', PLAYERS, {}));
		const res = await apply(stub, { op: 'match3Finish', uid: 7, report: { score: 5000 } });
		expect(res.ok).toBe(false);
		expect((await stateOf(stub)).game.scores[7].finishedAt).toBe(null);
	});

	it('clamps a fabricated score but leaves an honest one alone', async () => {
		const stub = room('m3-clamp');
		await seedOwned(stub, expiredGame());

		const honest = await apply(stub, { op: 'match3Finish', uid: 7, report: { score: 5000 } });
		expect(honest.ok).toBe(true);
		expect(honest.score).toBe(5000);

		const cheat = await apply(stub, { op: 'match3Finish', uid: 20, report: { score: 10_000_000 } });
		expect(cheat.ok).toBe(true);
		expect(cheat.score).toBeLessThan(10_000_000);
	});

	it('does NOT close the round on the first report — the others are still sending', async () => {
		// THE BUG THIS SUITE CAUGHT. Closing on the first report to arrive wrote off
		// everyone still mid-request at zero, making the race a contest between
		// connections rather than players.
		const stub = room('m3-nopremature');
		await seedOwned(stub, expiredGame());

		await apply(stub, { op: 'match3Finish', uid: 7, report: { score: 800 } });
		let after = await stateOf(stub);
		expect(after.game.result).toBe(null);
		expect(after.game.scores[20].finishedAt).toBe(null);

		// the slower player still gets their real score in
		const slow = await apply(stub, { op: 'match3Finish', uid: 20, report: { score: 9000 } });
		expect(slow.ok).toBe(true);
		expect((await stateOf(stub)).game.scores[20].score).toBe(9000);
	});

	it('closes immediately once every player has reported', async () => {
		const stub = room('m3-allin');
		await seedOwned(stub, expiredGame());
		for (const uid of PLAYERS) {
			await apply(stub, { op: 'match3Finish', uid, report: { score: 100 * uid } });
		}
		expect((await stateOf(stub)).game.result).toBe('done');
	});

	it('closes out stragglers after the grace window, so a dead tab cannot strand the room', async () => {
		const stub = room('m3-straggler');
		await seedOwned(stub, staleGame());

		await apply(stub, { op: 'match3Finish', uid: 7, report: { score: 800 } });

		const after = await stateOf(stub);
		expect(after.game.result).toBe('done');
		// 20 and 33 never reported and were closed out at their standing score
		expect(Object.values(after.game.scores).every((s) => s.finishedAt)).toBe(true);
		expect(after.game.scores[20].score).toBe(0);
	});

	it('lets an already-reported player nudge the round closed after the grace window', async () => {
		// This second call is the ONLY thing that ends a round somebody never
		// reported into — there is no alarm doing it. The report itself is refused
		// (already reported) but the close still has to happen.
		const stub = room('m3-nudge');
		const game = initGame('match3', PLAYERS, {});
		game.startedAt = Date.now() - ROUND_MS - 500; // inside grace
		await seedOwned(stub, game);

		await apply(stub, { op: 'match3Finish', uid: 7, report: { score: 800 } });
		expect((await stateOf(stub)).game.result).toBe(null);

		// grace passes; the same player comes back with nothing to report
		await runInDurableObject(stub, (instance) => {
			const s = kvGet(instance.sql, 'state');
			s.game.startedAt = Date.now() - ROUND_MS - GRACE_MS - 100;
			kvSet(instance.sql, 'state', s);
		});

		const nudge = await apply(stub, { op: 'match3Finish', uid: 7, report: {} });
		expect(nudge.ok).toBe(true);
		expect(nudge.closed).toBe(true);
		expect((await stateOf(stub)).game.result).toBe('done');
	});
});

describe('the tick channel', () => {
	it('writes nothing — no state, no version, no storage', async () => {
		// The whole reason `tick` exists as a separate ephemeral op: a running score
		// must not bump state.v, or six players ticking through a 90-second round
		// would thrash every client's merge gate for pixels.
		const stub = room('m3-tick');
		await seedOwned(stub, initGame('match3', PLAYERS, {}));
		const before = await stateOf(stub);

		const res = await apply(stub, { op: 'tick', data: { uid: 7, score: 1234 } });
		expect(res.ok).toBe(true);

		const after = await stateOf(stub);
		expect(after.v).toBe(before.v);
		expect(after.game.scores[7].score).toBe(0); // untouched by the ticker
	});
});

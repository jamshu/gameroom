// Runnable check for the two race games' server rules.
// Run: node src/lib/shared/race-check.js
//
// The single most important thing asserted here is what gameView WITHHOLDS.
// `gameView` is the only path a game takes on its way to a client, and it
// returns unknown types RAW — so a missing branch is not a crash, it is a silent
// leak of the sudoku answer key to everyone in the room. The obvious half of
// that (don't ship `solution`) is easy to remember; the other half is that a
// rival's `filled` map IS a growing copy of the solution, so it has to go too.
//
// The rest pins the rules the DO and the routes share: wrong digits are rejected
// rather than placed, the freeze is enforced server-side, first finish wins, and
// a client-reported match-3 score is clamped rather than trusted.
import assert from 'node:assert';
import {
	initGame, gameView, stateView, winnerUids, gameSeatUids,
	applySudokuFill, applyMatch3Finish, closeMatch3, match3Expired,
	sudokuScores, match3Scores
} from './gamelogic.js';
import { FREEZE_MS, progressOf } from './sudoku.js';
import { ROUND_MS, GRACE_MS, scoreCeiling } from './match3.js';

const UIDS = [11, 22, 33];
const room = {};

const newSudoku = () => initGame('sudoku', UIDS, room);
const newMatch3 = () => initGame('match3', UIDS, room);

/** Fill a player's whole grid correctly, one legal entry at a time. */
function solveFor(game, uid, now = Date.now()) {
	let last = null;
	for (let i = 0; i < 81; i++) {
		if (game.puzzle[i] !== 0) continue;
		last = applySudokuFill(game, uid, i, game.solution[i], now);
		assert.ok(last.ok && last.correct, `filling cell ${i} with the right digit must be accepted`);
	}
	return last;
}

/* ------------------------------ construction ------------------------------ */

// (a) player counts are enforced, and a fresh game is coherent.
{
	for (const type of ['sudoku', 'match3']) {
		assert.throws(() => initGame(type, [1], room), /2 to 6/, `${type}: one player is not a race`);
		assert.throws(() => initGame(type, [1, 2, 3, 4, 5, 6, 7], room), /2 to 6/, `${type}: caps at six`);
		const g = initGame(type, UIDS, room);
		assert.deepEqual(gameSeatUids(g), UIDS);
		assert.equal(g.result, null);
		assert.ok(g.seed, 'a race is dealt from a seed');
		assert.ok(g.startedAt > 0, 'and stamps its own start');
	}
}

// (b) the seed is minted per game — this is what makes /rematch deal a NEW
//     puzzle. Re-running initGame is the whole reset path (see returnToLobby /
//     resetRound), so a room-derived seed would replay the grid just solved.
{
	assert.notEqual(newSudoku().seed, newSudoku().seed, 'sudoku reseeds every deal');
	assert.notEqual(newMatch3().seed, newMatch3().seed, 'match3 reseeds every deal');
	assert.notDeepEqual(newSudoku().puzzle, newSudoku().puzzle, 'so the puzzle actually differs');
}

/* --------------------------- what gameView hides -------------------------- */

// (c) THE LEAK TEST. A player, a rival and a spectator each get a view; none of
//     them may contain the answer key by either route.
{
	const g = newSudoku();
	// give the rival some progress so there is something to leak
	const blanks = g.puzzle.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
	for (const i of blanks.slice(0, 10)) applySudokuFill(g, 22, i, g.solution[i]);

	for (const [label, viewer] of [['player', 11], ['rival', 22], ['spectator', 999]]) {
		const v = gameView(g, viewer);
		assert.equal(v.solution, undefined, `${label} must not receive the solution`);
		assert.ok(!('solution' in v), `${label}: the key must be absent, not merely undefined`);
		// nothing anywhere in the payload may spell out the full answer
		assert.ok(
			!JSON.stringify(v).includes(JSON.stringify(g.solution)),
			`${label}: the solution must not survive serialization by any route`
		);
		for (const [id, b] of Object.entries(v.boards)) {
			if (Number(id) === viewer) continue;
			assert.equal(b.filled, undefined, `${label} must not see ${id}'s answers`);
			assert.equal(typeof b.pct, 'number', 'but must see how far along they are');
			assert.equal(typeof b.mistakes, 'number');
		}
	}

	// the viewer's OWN board keeps its digits and its freeze — it has to, that is
	// the grid they are looking at
	const mine = gameView(g, 22).boards[22];
	assert.equal(Object.keys(mine.filled).length, 10);
	assert.equal(typeof mine.frozenUntil, 'number');

	// a spectator holds no seat at all and must not crash the projection
	const spec = gameView(g, 999);
	assert.equal(Object.keys(spec.boards).length, UIDS.length, 'a spectator sees every player');
	assert.ok(UIDS.every((u) => spec.boards[u].filled === undefined), 'and nobody\'s answers');

	// the source game is untouched by being viewed
	assert.ok(Array.isArray(g.solution) && g.solution.length === 81, 'gameView must not mutate');
}

// (c2) the same, through stateView — which is the shape that ACTUALLY goes over
//      the socket and down the poll. Asserting only gameView would pass happily
//      if stateView ever stopped routing `game` through it, and the leak would be
//      live with a green test suite. Pin the real boundary, not the helper.
{
	const g = newSudoku();
	const state = { v: 3, wins: {}, voice: [], game: g };
	for (const viewer of [11, 22, 999]) {
		const sv = stateView(state, viewer);
		assert.ok(!('solution' in sv.game), `stateView leaks the solution to ${viewer}`);
		assert.ok(
			!JSON.stringify(sv).includes(JSON.stringify(g.solution)),
			`the whole envelope must not carry the answer key (${viewer})`
		);
	}
	assert.ok(Array.isArray(g.solution) && g.solution.length === 81, 'and the server keeps its copy');
}

// (d) match3 hides only the swap logs — the seed is public by design, since both
//     players building the same board from it IS the game.
{
	const g = newMatch3();
	g.logs[11] = [[0, 1], [2, 3]];
	const v = gameView(g, 22);
	assert.equal(v.logs, undefined, 'a rival must not watch your moves');
	assert.ok(v.seed, 'but the seed is deliberately shared');
	assert.ok(v.scores, 'and so is the score ticker');
	assert.deepEqual(g.logs[11], [[0, 1], [2, 3]], 'gameView must not mutate');
}

/* ------------------------------ sudoku rules ------------------------------ */

// (e) a wrong digit is rejected, counted and freezes the player; a right one
//     lands. The freeze is enforced HERE, not in the UI — a client ignoring its
//     own countdown must still be refused.
{
	const g = newSudoku();
	const blank = g.puzzle.findIndex((v) => v === 0);
	const right = g.solution[blank];
	const wrong = (right % 9) + 1;
	const t0 = 1_000_000;

	const bad = applySudokuFill(g, 11, blank, wrong, t0);
	assert.ok(bad.ok, 'a wrong entry is a legal move, not a protocol error');
	assert.equal(bad.correct, false);
	assert.equal(g.boards[11].mistakes, 1);
	assert.equal(g.boards[11].frozenUntil, t0 + FREEZE_MS);
	assert.equal(g.boards[11].filled[blank], undefined, 'the wrong digit is NOT placed');

	// frozen: even the correct digit is refused until the penalty expires
	const early = applySudokuFill(g, 11, blank, right, t0 + FREEZE_MS - 1);
	assert.equal(early.ok, false);
	assert.equal(early.code, 'frozen');
	assert.equal(g.boards[11].filled[blank], undefined);

	const good = applySudokuFill(g, 11, blank, right, t0 + FREEZE_MS);
	assert.ok(good.ok && good.correct, 'and accepted the moment it lifts');
	assert.equal(g.boards[11].filled[blank], right);

	// a filled cell cannot be overwritten, and a given cannot be typed over
	assert.equal(applySudokuFill(g, 11, blank, right, t0 + FREEZE_MS).ok, false);
	const given = g.puzzle.findIndex((v) => v !== 0);
	assert.equal(applySudokuFill(g, 11, given, 1, t0 + FREEZE_MS).ok, false);
}

// (f) input validation and identity — a non-player cannot write into the game,
//     and nonsense coordinates are refused rather than stored.
{
	const g = newSudoku();
	const blank = g.puzzle.findIndex((v) => v === 0);
	assert.equal(applySudokuFill(g, 4242, blank, 1).ok, false, 'a stranger is not a player');
	for (const cell of [-1, 81, 1.5, 'x', null, undefined]) {
		assert.equal(applySudokuFill(g, 11, cell, 1).ok, false, `cell ${cell}`);
	}
	for (const digit of [0, 10, -3, 2.5, 'x', null]) {
		assert.equal(applySudokuFill(g, 11, blank, digit).ok, false, `digit ${digit}`);
	}
	// none of that touched the board
	assert.equal(Object.keys(g.boards[11].filled).length, 0);
}

// (g) first correct finish wins outright, and a later finisher cannot displace
//     them. Mistakes do not change the winner — the freeze has already been paid.
{
	const g = newSudoku();
	const res = solveFor(g, 22);
	assert.ok(res.finished && res.won);
	assert.equal(g.result, 22);
	assert.ok(g.boards[22].doneAt > 0);
	assert.deepEqual(winnerUids(g), [22]);
	assert.deepEqual(sudokuScores(g), { 11: 0, 22: 1, 33: 0 });

	// the race is over: nobody else may keep filling
	const blank = g.puzzle.findIndex((v) => v === 0);
	assert.equal(applySudokuFill(g, 11, blank, g.solution[blank]).ok, false, 'the race is closed');
	assert.equal(g.result, 22, 'and the winner stands');
}

// (h) an unfinished race has no winner and pays nobody. `winnerUids` returning
//     [] for an unknown type is silent, so this pins the branch as present.
{
	const g = newSudoku();
	assert.deepEqual(winnerUids(g), []);
	const blanks = g.puzzle.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
	for (const i of blanks.slice(0, 5)) applySudokuFill(g, 11, i, g.solution[i]);
	assert.deepEqual(winnerUids(g), [], 'partial progress is not a win');
	assert.ok(progressOf(g.puzzle, g.boards[11].filled).done === 5);
}

/* ------------------------------ match-3 rules ----------------------------- */

// (i) the clock is the server's. A finish before it runs out is refused however
//     the client asks — this is the chess `flag` pattern: the client notices,
//     the server decides.
{
	const g = newMatch3();
	const t0 = g.startedAt;
	assert.ok(!match3Expired(g, t0 + ROUND_MS - 1));
	assert.ok(match3Expired(g, t0 + ROUND_MS));

	assert.equal(applyMatch3Finish(g, 11, { score: 100 }, t0 + 1000).ok, false, 'too early');
	assert.equal(g.scores[11].finishedAt, null, 'and nothing was recorded');

	const ok = applyMatch3Finish(g, 11, { score: 4200, swaps: 40 }, t0 + ROUND_MS);
	assert.ok(ok.ok);
	assert.equal(g.scores[11].score, 4200);
	assert.equal(applyMatch3Finish(g, 11, { score: 9999 }, t0 + ROUND_MS).ok, false, 'no second report');
	assert.equal(g.scores[11].score, 4200, 'the first report stands');
}

// (j) a fabricated score is clamped; an honest one is untouched. The ceiling is
//     the whole of the anti-cheat here, because the score is client-computed by
//     design (the refill queue is client-generated from the shared seed).
{
	const g = newMatch3();
	const end = g.startedAt + ROUND_MS;
	const honest = applyMatch3Finish(g, 11, { score: 5000 }, end);
	assert.equal(honest.clamped, false, 'a real round is never touched');
	assert.equal(g.scores[11].score, 5000);

	const cheat = applyMatch3Finish(g, 22, { score: 10_000_000 }, end);
	assert.ok(cheat.clamped, 'a fabricated score is caught');
	assert.equal(g.scores[22].score, scoreCeiling(ROUND_MS));

	// junk reports degrade to zero rather than NaN — a NaN would poison the max
	// in winnerUids and make nobody the winner
	applyMatch3Finish(g, 33, { score: 'lots' }, end);
	assert.equal(g.scores[33].score, 0);
	assert.ok(Number.isFinite(g.scores[33].score));
}

// (k) the round closes when everyone has reported, and the top score wins.
{
	const g = newMatch3();
	const end = g.startedAt + ROUND_MS;
	applyMatch3Finish(g, 11, { score: 1000 }, end);
	applyMatch3Finish(g, 22, { score: 3000 }, end);
	assert.equal(g.result, null, 'still waiting on the third player');
	assert.deepEqual(winnerUids(g), [], 'and nobody has won yet');

	const last = applyMatch3Finish(g, 33, { score: 2000 }, end);
	assert.ok(last.finished);
	assert.equal(g.result, 'done');
	assert.deepEqual(winnerUids(g), [22]);
	assert.deepEqual(match3Scores(g), { 11: 0, 22: 1, 33: 0 });
}

// (l) a tie pays everyone who tied, and a round nobody scored in pays no one.
{
	const g = newMatch3();
	const end = g.startedAt + ROUND_MS;
	applyMatch3Finish(g, 11, { score: 2500 }, end);
	applyMatch3Finish(g, 22, { score: 2500 }, end);
	applyMatch3Finish(g, 33, { score: 100 }, end);
	assert.deepEqual(winnerUids(g).sort((a, b) => a - b), [11, 22], 'joint winners both score');
	assert.deepEqual(match3Scores(g), { 11: 1, 22: 1, 33: 0 });

	const zero = newMatch3();
	const zEnd = zero.startedAt + ROUND_MS;
	for (const u of UIDS) applyMatch3Finish(zero, u, { score: 0 }, zEnd);
	assert.deepEqual(winnerUids(zero), [], 'nobody scored: no winner rather than everyone');
}

// (m) a straggler cannot hold the room hostage — but only AFTER the grace
//     window, so the players still mid-request are not written off.
//
//     This is the bug the DO suite caught: closing on the first report to arrive
//     zeroed everyone else's score, turning the race into a contest between
//     connections rather than players.
{
	const g = newMatch3();
	const end = g.startedAt + ROUND_MS;
	applyMatch3Finish(g, 11, { score: 800 }, end);

	assert.equal(closeMatch3(g, g.startedAt + 1000), false, 'not while the clock still runs');
	assert.equal(closeMatch3(g, end), false, 'nor the instant it expires — others are still reporting');
	assert.equal(closeMatch3(g, end + GRACE_MS - 1), false, 'nor a moment before the grace is up');
	assert.equal(g.scores[22].finishedAt, null, 'so a slow player has not been written off');

	// the slow player gets in during the grace window, at their real score
	assert.ok(applyMatch3Finish(g, 22, { score: 9000 }, end + 1000).ok);
	assert.equal(g.scores[22].score, 9000);

	assert.ok(closeMatch3(g, end + GRACE_MS), 'and after the grace, the round closes');
	assert.equal(g.result, 'done');
	assert.ok(Object.values(g.scores).every((s) => s.finishedAt), 'everyone is closed out');
	assert.deepEqual(winnerUids(g), [22], 'the best score that actually arrived wins');
	assert.equal(closeMatch3(g, end + GRACE_MS), false, 'and closing twice is a no-op');
}

// (m2) everyone reporting closes the round IMMEDIATELY — the grace window is a
//      backstop for absent players, not a delay every round has to sit through.
{
	const g = newMatch3();
	const end = g.startedAt + ROUND_MS;
	for (const u of UIDS) applyMatch3Finish(g, u, { score: 100 }, end);
	assert.equal(g.result, 'done', 'no waiting once everyone is in');
}

// (n) a non-player cannot report a score into someone else's race.
{
	const g = newMatch3();
	assert.equal(applyMatch3Finish(g, 4242, { score: 5 }, g.startedAt + ROUND_MS).ok, false);
}

console.log('race-check: all assertions passed');

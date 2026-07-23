// Runnable check for the ludo rules — dice/move/capture/win edge cases.
// Run: node src/lib/server/ludo-check.js
import assert from 'node:assert';
import { register } from 'node:module';
register('./thief-env-stub-loader.mjs', import.meta.url);
const { initGame, ludoRoll, ludoMove, ludoLegalMoves, ludoScores } = await import('./gamelogic.js');

const A = 100, B = 101; // A = red (offset 0), B = yellow (offset 26) for a 2-player game
const fresh = () => initGame('ludo', [A, B], {});

// 1. Need a 6 to leave the yard.
{
	const g = fresh();
	assert.equal(ludoLegalMoves(g, A, 3).length, 0, 'no move without a 6 when all tokens are home');
	assert.equal(ludoLegalMoves(g, A, 6).length, 4, 'a 6 frees any of the four yard tokens');
	assert.deepEqual(ludoLegalMoves(g, A, 6)[0], { token: 0, target: 0 }, 'yard token enters at rel 0');
}

// 2. Roll a 6 → move → same player keeps the turn (extra roll).
{
	const g = fresh();
	g.tokens[A][0] = 0; // already on the board
	ludoRoll(g, A, 6);
	assert.equal(g.rolled, true);
	ludoMove(g, A, 0);
	assert.equal(g.tokens[A][0], 6, 'token advanced by 6');
	assert.equal(g.turnIdx, 0, 'rolling a 6 grants another turn');
	assert.equal(g.rolled, false, 'must roll again for the extra turn');
}

// 3. Three 6s in a row forfeits the turn.
{
	const g = fresh();
	g.tokens[A][0] = 0;
	ludoRoll(g, A, 6); ludoMove(g, A, 0); // streak 1
	ludoRoll(g, A, 6); ludoMove(g, A, 0); // streak 2
	ludoRoll(g, A, 6);                    // streak 3 → forfeit
	assert.equal(g.turnIdx, 1, 'third six passes the turn');
	assert.equal(g.rolled, false);
	assert.equal(g.sixStreak, 0, 'streak resets after forfeit');
	assert.equal(g.lastEvent.reason, 'three-sixes');
}

// 4. Exact finish: overshooting home is illegal.
{
	const g = fresh();
	g.tokens[A][0] = 54; // two from home (56)
	assert.ok(!ludoLegalMoves(g, A, 3).some((m) => m.token === 0), 'overshoot (57) is not offered');
	const finish = ludoLegalMoves(g, A, 2).find((m) => m.token === 0);
	assert.deepEqual(finish, { token: 0, target: 56 }, 'exact roll finishes the token');
}

// 5. Capture: landing on a lone opponent on a non-safe cell sends it home + extra turn.
{
	const g = fresh();
	g.tokens[B][0] = 5;   // yellow rel 5 → abs (26+5)%52 = 31 (a non-safe cell)
	g.tokens[A][0] = 28;  // red rel 28; +3 → rel 31 → abs 31, same cell
	g.turnIdx = 0; g.dice = 3; g.rolled = true;
	ludoMove(g, A, 0);
	assert.equal(g.tokens[A][0], 31, 'red advanced onto the shared cell');
	assert.equal(g.tokens[B][0], -1, 'captured yellow token is sent back to the yard');
	assert.equal(g.turnIdx, 0, 'a capture grants another turn');
	assert.equal(g.lastEvent.kind, 'capture');
}

// 6. Safe square: an opponent on a star cell is immune.
{
	const g = fresh();
	// abs 8 is a safe star. Yellow rel r with (26+r)%52 = 8 → r = 34.
	g.tokens[B][0] = 34;
	g.tokens[A][0] = 5;   // red rel 5; +3 → rel 8 → abs 8 (a safe star)
	g.turnIdx = 0; g.dice = 3; g.rolled = true;
	ludoMove(g, A, 0);
	assert.equal(g.tokens[A][0], 8, 'red moved onto the safe cell');
	assert.equal(g.tokens[B][0], 34, 'yellow on the safe cell is NOT captured');
	assert.equal(g.turnIdx, 1, 'no 6/capture/home → turn passes');
}

// 7. A roll with no legal move passes the turn automatically.
{
	const g = fresh(); // all tokens in the yard
	ludoRoll(g, A, 4);
	assert.equal(g.turnIdx, 1, 'no legal move → next player');
	assert.equal(g.lastEvent.kind, 'pass');
	assert.equal(g.dice, null);
}

// 8. Bringing the last token home wins the game.
{
	const g = fresh();
	g.tokens[A] = [56, 56, 56, 54];
	g.turnIdx = 0; g.dice = 2; g.rolled = true;
	ludoMove(g, A, 3);
	assert.equal(g.tokens[A][3], 56, 'final token reaches home');
	assert.equal(g.result, A, 'all four home → winner');
	assert.deepEqual(g.finished, [A]);
}

// 9. ludoScores returns a numeric progress score per player.
{
	const g = fresh();
	g.tokens[A] = [56, 56, 56, 56]; // all home = 4 * 57
	g.tokens[B] = [-1, -1, -1, -1]; // all in yard = 0
	const s = ludoScores(g);
	assert.equal(s[A], 4 * 57);
	assert.equal(s[B], 0);
}

console.log('ludo-check: all assertions passed');

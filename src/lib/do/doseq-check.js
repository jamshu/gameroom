// check:doseq — the event log's id space, run against REAL SQLite.
//
// node:sqlite rather than a hand-rolled fake, deliberately. Almost everything
// asserted below is a property of SQLite itself — AUTOINCREMENT's monotonicity,
// the `sqlite_sequence` row's existence rules, whether a deleted id can come
// back — and a fake that merely counted upwards would agree with every
// assertion here while telling us nothing about the code that ships. The shim is
// six lines wide precisely so that it cannot smuggle in behaviour of its own.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
	migrate, kvGet, kvSet, seedSequence,
	appendEvent, eventsFor, newestFor, headSeq, oldestSeq, trim, rowsOfType
} from './schema.js';
import { hasGap, uptoOf } from './frames.js';
import { resolveClaims, filterPickRows } from '../shared/gamelogic.js';

/** The narrowest possible stand-in for Cloudflare's SqlStorage.exec. */
function newSql() {
	const db = new DatabaseSync(':memory:');
	return {
		exec(query, ...bindings) {
			// migrate() is the only multi-statement call, and it takes no bindings.
			if (!bindings.length && query.includes(';')) return db.exec(query), [];
			return db.prepare(query).all(...bindings);
		}
	};
}

const PUB = { type: 'chat', sender: 7, target: null, payload: { text: 'hi' } };

/* 1. THE SEED. The one assertion in this file that is about a crash rather than
      a stalled feed: clients render chat as a keyed {#each} keyed on the event
      id, so a fresh object minting from 1 collides with Odoo ids already in
      their store. Ownership transfer seeds above Odoo's max; this proves the
      very next mint clears it. */
{
	const sql = newSql();
	migrate(sql);
	seedSequence(sql, 4210); // pretend max(x_room_event.id) = 4210
	const seq = appendEvent(sql, PUB);
	assert.equal(seq, 4211, 'the first DO-minted id must be ABOVE Odoo highest, not 1');
	assert.ok(seq > 4210, 'seed > max(x_room_event.id)');
}

/* 2. Monotonic: a later, lower seed must never pull the sequence back down.
      hydrate and ensureOwned both call this, and ensureOwned runs second. */
{
	const sql = newSql();
	migrate(sql);
	seedSequence(sql, 900);
	appendEvent(sql, PUB); // 901
	seedSequence(sql, 500); // a stale floor
	assert.equal(appendEvent(sql, PUB), 902, 'a lower seed must not rewind the sequence');
}

/* 3. An explicitly-numbered insert (a push carrying an Odoo id, or a backfilled
      row) has to drag the sequence up with it, or the next mint lands on top of
      a row that already exists. */
{
	const sql = newSql();
	migrate(sql);
	appendEvent(sql, { ...PUB, seq: 3001, archived: 1 });
	assert.equal(appendEvent(sql, PUB), 3002, 'a minted id must clear every explicit one');
}

/* 4. Redelivery is not duplication. The same event arriving twice — a retried
      push — must leave one row, because the id is Odoo's primary key. */
{
	const sql = newSql();
	migrate(sql);
	appendEvent(sql, { ...PUB, seq: 55 });
	appendEvent(sql, { ...PUB, seq: 55 });
	assert.equal(eventsFor(sql, 7, 0).length, 1, 'INSERT OR REPLACE: one row per event id');
}

/* 5. TARGET FILTERING — the reason the watermark exists at all. A WebRTC signal
      for uid 20 must be invisible to uid 10, so uid 10's view of the sequence
      has a hole BY DESIGN and cannot be distinguished from "not sent yet". */
{
	const sql = newSql();
	migrate(sql);
	const a = appendEvent(sql, PUB); // public
	const s = appendEvent(sql, { type: 'signal', sender: 20, target: 10, payload: { kind: 'offer' } });
	const t = appendEvent(sql, { type: 'signal', sender: 10, target: 20, payload: { kind: 'answer' } });
	const c = appendEvent(sql, PUB); // public

	const forTen = eventsFor(sql, 10, 0).map((e) => e.id);
	assert.deepEqual(forTen, [a, s, c], 'uid 10 sees public + its own targeted, never uid 20 s');
	assert.deepEqual(eventsFor(sql, 20, 0).map((e) => e.id), [a, t, c], 'and symmetrically for 20');

	// The invariant itself: a watermark derived from what this socket ACTUALLY
	// received is below the head, and stamping the head instead is exactly how the
	// voice dropouts happened — the cursor would step over `t` and never refetch.
	assert.equal(uptoOf(forTen.map((id) => ({ id }))), c, 'upto = max seq present in the replay');
	assert.ok(uptoOf(forTen.map((id) => ({ id }))) <= headSeq(sql), 'never above the head');
	const midway = eventsFor(sql, 10, 0).slice(0, 2).map((e) => ({ id: e.id }));
	assert.ok(uptoOf(midway) < headSeq(sql), 'a partial replay must NOT claim the head');
}

/* 6. Replay completeness and order: everything above the cursor the caller is
      entitled to, oldest first — the same contract as the Odoo poll it replaces
      (`order: id asc, limit: 200`). */
{
	const sql = newSql();
	migrate(sql);
	const ids = [];
	for (let i = 0; i < 10; i++) ids.push(appendEvent(sql, PUB));
	const got = eventsFor(sql, 7, ids[3]).map((e) => e.id);
	assert.deepEqual(got, ids.slice(4), 'strictly above the cursor, nothing skipped');
	assert.deepEqual([...got].sort((x, y) => x - y), got, 'ascending');
	assert.deepEqual(newestFor(sql, 7, 3).map((e) => e.id), ids.slice(-3), 'the tail, still oldest-first');
}

/* 7. TRIM. Only archived rows go, so a write-behind outage grows the log rather
      than losing history — and a trimmed id is never handed out again. */
{
	const sql = newSql();
	migrate(sql);
	const ids = [];
	for (let i = 0; i < 20; i++) ids.push(appendEvent(sql, { ...PUB, archived: 1 }));
	const unarchived = appendEvent(sql, PUB); // still owed to Odoo

	trim(sql, 5);
	const left = eventsFor(sql, 7, 0).map((e) => e.id);
	assert.ok(left.includes(unarchived), 'an unarchived row must survive the trim');
	assert.ok(!left.includes(ids[0]), 'archived rows below the cutoff are gone');
	assert.ok(oldestSeq(sql) > ids[0], 'oldest rose');

	const next = appendEvent(sql, PUB);
	assert.ok(next > headSeq(sql) - 1 && next > ids.at(-1), 'AUTOINCREMENT never reuses a trimmed id');
	assert.ok(!left.includes(next), 'and therefore cannot collide with a retained one');
}

/* 8. The gap signal, which is what stops a trim silently eating a block of chat.
      Both transports ask through hasGap, so this covers the socket's `resync`
      and the poll's `gap: true` at once. */
{
	const sql = newSql();
	migrate(sql);
	for (let i = 0; i < 20; i++) appendEvent(sql, { ...PUB, archived: 1 });
	trim(sql, 5);
	const oldest = oldestSeq(sql);

	assert.equal(hasGap(oldest - 1, oldest), true, 'a cursor below the retained log is a gap');
	assert.equal(hasGap(oldest, oldest), false, 'exactly at the oldest is continuous');
	assert.equal(hasGap(oldest + 1, oldest), false, 'and above it certainly is');
	assert.equal(hasGap(0, oldest), false, 'a fresh client has nothing to have missed');
	assert.equal(hasGap(5, 0), false, 'an empty log cannot have dropped anything');
}

/* 9. Backfilled rows arrive as the JSON STRING Odoo stored, freshly appended
      ones as an object. Re-stringifying the former would hand the client
      "{\"text\":…}" as its payload — chat that renders as raw JSON. */
{
	const sql = newSql();
	migrate(sql);
	appendEvent(sql, { seq: 12, type: 'chat', sender: 7, payload: '{"text":"from odoo"}', archived: 1 });
	appendEvent(sql, { type: 'chat', sender: 7, payload: { text: 'from the DO' } });
	const [a, b] = eventsFor(sql, 7, 0);
	assert.deepEqual(a.payload, { text: 'from odoo' }, 'a backfilled string payload is not double-encoded');
	assert.deepEqual(b.payload, { text: 'from the DO' }, 'and an object payload still round-trips');
}

/* 10. Backfilled rows must not be archived a second time — they came FROM Odoo.
       Re-creating them would duplicate the room's whole chat history. */
{
	const sql = newSql();
	migrate(sql);
	appendEvent(sql, { seq: 12, ...PUB, archived: 1 });
	appendEvent(sql, PUB);
	const pending = sql.exec('SELECT seq FROM events WHERE archived = 0');
	assert.equal([...pending].length, 1, 'only the DO-minted row is owed to Odoo');
}

/* 11. ONE THIEF-FINDER ARBITER, TWO STORES. rowsOfType hands resolveClaims the
       same shape the Odoo search_read did, so first-come order and the
       picking→guessing flip are decided by identical code either way. If these
       ever diverge, two players open the same envelope. */
{
	const sql = newSql();
	migrate(sql);
	const game = {
		type: 'thief_finder', epoch: 'e1', draw: 2,
		players: [10, 20], envelopes: ['Police', 'Thief'],
		claims: {}, policeUid: null, phase: 'picking', secret: null, totals: {}
	};
	// A previous draw's pick, which filterPickRows must exclude...
	appendEvent(sql, { type: 'pick', sender: 20, payload: { epoch: 'e1', draw: 1, envelope: 0 } });
	// ...then this draw's, in first-come order.
	appendEvent(sql, { type: 'pick', sender: 10, payload: { epoch: 'e1', draw: 2, envelope: 0 } });
	appendEvent(sql, { type: 'pick', sender: 20, payload: { epoch: 'e1', draw: 2, envelope: 0 } }); // loses
	appendEvent(sql, { type: 'pick', sender: 20, payload: { epoch: 'e1', draw: 2, envelope: 1 } });
	appendEvent(sql, { type: 'chat', sender: 10, payload: { text: 'noise' } });

	const rows = rowsOfType(sql, 'pick');
	assert.equal(rows.length, 4, 'rowsOfType selects by type only, in seq order');
	assert.ok('x_studio_sender_uid' in rows[0] && 'x_studio_payload' in rows[0], 'the Odoo row shape');
	assert.equal(typeof rows[0].x_studio_payload, 'string', 'payload stays a JSON string, as safePayload expects');

	resolveClaims(game, filterPickRows(rows, game));
	assert.deepEqual(game.claims, { 0: 10, 1: 20 }, 'first-come wins; the earlier seq keeps envelope 0');
	assert.equal(game.policeUid, 10, 'Police is whoever holds the Police envelope');
	assert.equal(game.phase, 'guessing', 'every envelope claimed flips the phase');
}

/* 12. kv round-trips, including the falsy values the alarm scheduler stores.
       `next_idle_at = 0` means "cancelled", and a kvGet that handed back the
       fallback instead would re-arm a wind-down that was deliberately turned
       off — an idle room that never stops billing. */
{
	const sql = newSql();
	migrate(sql);
	kvSet(sql, 'next_idle_at', 0);
	assert.equal(kvGet(sql, 'next_idle_at', 99), 0, '0 is a value, not a miss');
	kvSet(sql, 'owns_state', 0);
	assert.equal(kvGet(sql, 'owns_state'), 0, 'ownership can be cleared, and reads back falsy');
	assert.equal(kvGet(sql, 'never_set', 'fallback'), 'fallback', 'a genuine miss takes the fallback');
	kvSet(sql, 'state', { v: 3, voice: [1, 2] });
	assert.deepEqual(kvGet(sql, 'state'), { v: 3, voice: [1, 2] }, 'objects round-trip');
}

console.log('doseq-check: all assertions passed (seed, filtering, trim, gap, one thief arbiter)');

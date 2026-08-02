// Room Durable Object storage.
//
// ISOMORPHIC BY CONTRACT — no `$lib`, no `$env`. This is bundled by wrangler
// outside the SvelteKit build, where neither resolves. `check:noenv` enforces it.

export const EVENT_KEEP = 500; // rows retained by the trim alarm
export const REPLAY_MAX = 200; // events in a welcome/poll page — matches the old Odoo poll

export function migrate(sql) {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS events (
			seq      INTEGER PRIMARY KEY AUTOINCREMENT,
			type     TEXT    NOT NULL,
			sender   INTEGER NOT NULL DEFAULT 0,
			target   INTEGER,
			payload  TEXT    NOT NULL,
			ts       INTEGER NOT NULL,
			archived INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS ev_target  ON events(target, seq);
		CREATE INDEX IF NOT EXISTS ev_archive ON events(archived, seq);
		CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
	`);
}

/* ---- kv helpers ----------------------------------------------------------- */

export function kvGet(sql, key, fallback = null) {
	const row = [...sql.exec('SELECT v FROM kv WHERE k = ?', key)][0];
	if (!row) return fallback;
	try {
		return JSON.parse(row.v);
	} catch {
		return fallback;
	}
}

export function kvSet(sql, key, value) {
	sql.exec(
		'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
		key,
		JSON.stringify(value)
	);
}

/* ---- the sequence seed ---------------------------------------------------- */

/**
 * Push the event sequence above the room's highest existing Odoo event id.
 *
 * THIS IS NOT AN OPTIMISATION — skipping it crashes the client.
 *
 * Chat renders as a keyed {#each} and stores/room.js pushes `{ id: ev.id, … }`.
 * A client already in the room holds chat keyed by Odoo ids (thousands). A fresh
 * DO's AUTOINCREMENT starts at 1, so the first messages after the flip collide
 * with keys already in the store — a duplicate-key crash, not a stalled feed.
 * resolveLocalChat's `c.id === realId` test has the same exposure.
 *
 * `sqlite_sequence` only has a row once an AUTOINCREMENT insert has happened, so
 * handle both cases. Monotonic by construction: never lowers an existing value.
 */
export function seedSequence(sql, minSeq) {
	const floor = Number(minSeq) || 0;
	if (floor <= 0) return 0;
	const cur = [...sql.exec("SELECT seq FROM sqlite_sequence WHERE name = 'events'")][0]?.seq ?? 0;
	if (cur >= floor) return cur;
	if (cur === 0) {
		sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)", floor);
	} else {
		sql.exec("UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'", floor);
	}
	return floor;
}

/* ---- event log ------------------------------------------------------------ */

/**
 * Append one event. Returns its seq — which is also the new watermark.
 *
 * `seq` may be supplied, and during the transition it always is. While BOTH
 * transports are live the HTTP poll still returns Odoo row ids, so if the DO
 * minted its own ids from 1 the two streams would collide in a store that keys
 * chat by event id — the duplicate-key crash, not a merge glitch. Passing Odoo's
 * id through keeps one id space until hydration seeds the sequence above it.
 *
 * `archived` marks a row Odoo already holds, so the write-behind alarm skips it.
 * Set it for rows backfilled FROM Odoo at the ownership transfer — re-creating
 * those would duplicate every message in the archive.
 */
export function appendEvent(sql, { seq = null, type, sender = 0, target = null, payload = {}, archived = 0 }) {
	const t = String(type);
	const s = Number(sender) || 0;
	const tgt = target == null ? null : Number(target);
	// Backfilled rows arrive as the JSON STRING Odoo stored; freshly appended ones
	// arrive as an object. Re-stringifying a string would double-encode it and the
	// client would parse a payload of `"{\"kind\":…}"` instead of an object.
	const p = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
	const a = archived ? 1 : 0;
	const now = Date.now();

	if (seq != null && Number.isFinite(Number(seq))) {
		const explicit = Number(seq);
		// INSERT OR REPLACE: a redelivered push must not create a second row for the
		// same event. The id is Odoo's primary key, so it is already unique.
		sql.exec(
			'INSERT OR REPLACE INTO events (seq, type, sender, target, payload, ts, archived) VALUES (?, ?, ?, ?, ?, ?, ?)',
			explicit, t, s, tgt, p, now, a
		);
		// Keep AUTOINCREMENT above anything inserted explicitly, so a later
		// DO-minted id can never land on top of one of these.
		seedSequence(sql, explicit);
		return explicit;
	}

	const row = [
		...sql.exec(
			'INSERT INTO events (type, sender, target, payload, ts, archived) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq',
			t, s, tgt, p, now, a
		)
	][0];
	return row.seq;
}

/**
 * Every event of one type, oldest first, in the shape the Odoo `search_read`
 * returned — `x_studio_sender_uid` / `x_studio_payload`.
 *
 * The shape is deliberate rather than lazy: resolveClaims and filterPickRows are
 * shared, pure and already tested against those field names, so serving them the
 * same rows from a different store keeps ONE implementation of who-claimed-what.
 * A second shape here would be a second thief-finder arbiter.
 */
export function rowsOfType(sql, type) {
	return [
		...sql.exec('SELECT sender, payload FROM events WHERE type = ? ORDER BY seq ASC', String(type))
	].map((r) => ({ x_studio_sender_uid: r.sender, x_studio_payload: r.payload }));
}

/**
 * Events a given uid is entitled to, above `since`, oldest first.
 *
 * Oldest-first with a limit deliberately mirrors the Odoo poll it replaces
 * (`order: id asc, limit: 200`) so the HTTP envelope stays byte-identical.
 * `welcome` uses newestFor() instead — a joiner wants the tail, not the head.
 */
export function eventsFor(sql, uid, since, limit = REPLAY_MAX) {
	return [
		...sql.exec(
			`SELECT seq, type, sender, target, payload FROM events
			 WHERE seq > ? AND (target IS NULL OR target = ?)
			 ORDER BY seq ASC LIMIT ?`,
			Number(since) || 0,
			Number(uid),
			limit
		)
	].map(toClientEvent);
}

/** The newest `limit` events for a uid, returned oldest-first for replay. */
export function newestFor(sql, uid, limit = REPLAY_MAX) {
	const rows = [
		...sql.exec(
			`SELECT seq, type, sender, target, payload FROM events
			 WHERE target IS NULL OR target = ?
			 ORDER BY seq DESC LIMIT ?`,
			Number(uid),
			limit
		)
	];
	return rows.reverse().map(toClientEvent);
}

function toClientEvent(r) {
	let payload = {};
	try {
		payload = JSON.parse(r.payload);
	} catch {
		/* a malformed row must not take down the whole replay */
	}
	// Field names match the Odoo poll envelope exactly — `id`, not `seq`.
	return { id: r.seq, type: r.type, senderUid: r.sender, payload };
}

/** Highest seq in the log, or 0. */
export function headSeq(sql) {
	return [...sql.exec('SELECT MAX(seq) AS m FROM events')][0]?.m ?? 0;
}

/** Lowest seq still retained — anything below it was trimmed away. */
export function oldestSeq(sql) {
	return [...sql.exec('SELECT MIN(seq) AS m FROM events')][0]?.m ?? 0;
}

/**
 * Drop everything except the newest EVENT_KEEP rows.
 *
 * Only trims rows already archived to Odoo, so a write-behind outage can never
 * lose history: the log grows instead, which is the recoverable failure.
 */
export function trim(sql, keep = EVENT_KEEP) {
	const head = headSeq(sql);
	if (head <= keep) return 0;
	const cutoff = head - keep;
	const before = oldestSeq(sql);
	sql.exec('DELETE FROM events WHERE seq <= ? AND archived = 1', cutoff);
	const after = oldestSeq(sql);
	return after > before ? after - before : 0;
}

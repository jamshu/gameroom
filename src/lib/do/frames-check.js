// Guards the `upto` watermark invariant, which is not something you can eyeball:
//
//   A frame may only carry `upto = N` on a socket if every event with seq <= N
//   that this socket is entitled to has already been sent on that same socket.
//
// Violating it loses WebRTC signals permanently — the cursor advances past a
// targeted event the client never received, and the poll's `?since=` then never
// asks for it again. The symptom is voice stuck in `connecting` and a player
// forced to rejoin, which looks nothing like a watermark bug.
//
// Run: npm run check:frames
import assert from 'node:assert';
import { welcome, stateFrame, eventFrame, rosterFrame, aimFrame, ackFrame, errFrame, uptoOf, withSeq, CLOSE, PROTOCOL_VERSION } from './frames.js';

/* ---- the rule that broke voice ------------------------------------------- */

{
	// A state frame goes to EVERY socket but delivers no events, so it cannot
	// vouch for any. It must not carry a watermark at all.
	const f = stateFrame({ v: 9, game: {} });
	assert.strictEqual(f.t, 'state');
	assert.ok(!('upto' in f), 'state frames must NOT carry upto — they deliver no events');

	// Regression, stated concretely: a signal for B at seq 40, then a game move.
	// If the state frame carried the head, A and B would both jump to 40 — B
	// possibly past a signal it never got.
	const signalToB = eventFrame({ id: 40, type: 'signal', senderUid: 1, payload: {} }, 40);
	assert.strictEqual(signalToB.upto, 40, 'an event frame vouches for its own event');
	assert.ok(!('upto' in stateFrame({ v: 10 })), 'the following state frame must not vouch for seq 40');
}

{
	// A roster frame likewise delivers no events.
	const f = rosterFrame({ id: 1 }, [{ uid: 1 }], 1234);
	assert.ok(!('upto' in f), 'roster frames must NOT carry upto');
	assert.strictEqual(f.ts, 1234, 'roster needs ts — room/members carry no version of their own');
}

{
	// Aim is ephemeral: no seq, no storage, no watermark.
	const f = aimFrame({ uid: 7, aim: { dx: 1, dy: 2 } });
	assert.ok(!('upto' in f), 'aim frames must NOT carry upto');
}

/* ---- welcome / resync ----------------------------------------------------- */

{
	// upto is the max seq PRESENT IN THE REPLAY, never the current head. If an
	// event appends while the replay query is in flight, a head-derived watermark
	// would send the joiner past an event that went only to already-connected
	// sockets.
	const events = [{ id: 11 }, { id: 12 }, { id: 15 }];
	assert.strictEqual(uptoOf(events), 15);
	const w = welcome({ room: {}, members: [], state: null, events, epoch: 0 });
	assert.strictEqual(w.upto, 15, 'welcome.upto must come from the replay contents');
	assert.strictEqual(w.t, 'welcome');
	assert.strictEqual(w.v, PROTOCOL_VERSION);
	assert.ok(!('gap' in w), 'a normal welcome must not claim a gap');
}

{
	// An empty replay must not invent a watermark.
	assert.strictEqual(uptoOf([]), 0, 'empty replay -> 0');
	assert.strictEqual(uptoOf([], 7), 7, 'empty replay -> the supplied floor');
	const w = welcome({ room: {}, members: [], state: null, events: [], epoch: 0 });
	assert.strictEqual(w.upto, 0);
}

{
	// resync tells the client its cursor fell below the retained log, so it must
	// rebuild rather than assume continuity.
	const r = welcome({ room: {}, members: [], state: null, events: [{ id: 90 }], epoch: 3, gap: true });
	assert.strictEqual(r.t, 'resync');
	assert.strictEqual(r.gap, true);
	assert.strictEqual(r.upto, 90);
}

/* ---- acks ----------------------------------------------------------------- */

{
	const ok = ackFrame('r1', true, { seq: 5 });
	assert.deepStrictEqual(ok, { t: 'ack', id: 'r1', ok: true, seq: 5 });

	// Errors must mirror what api() throws, so the client's existing handling —
	// including the terminal `removed`/`not_member` codes — works over the socket.
	const err = errFrame('r2', 403, 'The host removed you', 'removed');
	assert.strictEqual(err.ok, false);
	assert.strictEqual(err.status, 403);
	assert.strictEqual(err.code, 'removed');
	assert.ok(!('code' in errFrame('r3', 500, 'boom')), 'code omitted when absent');
}

{
	// The close codes the client branches on. 4003 is terminal; 4002 means fall
	// back to HTTP without treating it as an error.
	assert.strictEqual(CLOSE.REAUTH, 4001);
	assert.strictEqual(CLOSE.EVACUATED, 4002);
	assert.strictEqual(CLOSE.KICKED, 4003);
}

{
	// THE SEQ ALWAYS WINS. This shipped wrong and was invisible for a milestone:
	// the old shape spread the caller's event OVER the id, which agreed with the
	// minted seq for as long as every event carried an Odoo id. The `append` op
	// passes id: null, so the spread put null back and every socket-delivered chat
	// message arrived keyed on null — a duplicate key in the client's keyed
	// {#each}, which is the crash the sequence seed exists to prevent.
	assert.strictEqual(withSeq({ id: null, type: 'chat' }, 4211).id, 4211,
		'a minted seq must replace a null id, not be replaced by it');
	assert.strictEqual(withSeq({ id: 9, type: 'chat' }, 4211).id, 4211,
		'and must replace a stale one too — the log decides, not the caller');
	assert.strictEqual(withSeq({ id: null, type: 'chat', senderUid: 7 }, 3).senderUid, 7,
		'every other field is carried through untouched');

	// And the frame built from it agrees with its own watermark, which is what
	// lets the client advance its cursor off an event frame at all.
	const f = eventFrame(withSeq({ id: null, type: 'chat' }, 4211), 4211);
	assert.strictEqual(f.event.id, f.upto, 'upto equals the id of the event it delivers');
}

console.log('frames-check: all assertions passed (state/roster/aim carry no watermark; seq beats caller id)');

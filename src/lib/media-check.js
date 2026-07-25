// Runnable check for the chat-media contract: the mime whitelist and the byte
// range parser behind the media proxy.
// Run: node src/lib/media-check.js
//
// The range half exists because iOS Safari WILL NOT play an <audio> source that
// answers a `Range` probe with 200 instead of 206 — that's why voice notes
// played on desktop but were dead on an iPhone while images, which never use
// Range, worked on both. Getting a boundary wrong here re-breaks it silently,
// and the failure only shows on a real device, so the rules are pinned down.
import assert from 'node:assert';
import { mimeAllowed, parseRange, AUDIO_MIMES, IMAGE_MIMES } from './media.js';

// (a) the whitelist — mp4 must be accepted for voice, because that's now the
//     container we prefer to record so iOS can play what everyone else sends.
{
	assert.ok(mimeAllowed('voice', 'audio/mp4'), 'iOS-playable voice must be allowed');
	assert.ok(mimeAllowed('voice', 'audio/webm'));
	assert.ok(!mimeAllowed('voice', 'image/png'), 'kinds do not share mimes');
	assert.ok(!mimeAllowed('image', 'audio/mp4'));
	assert.ok(!mimeAllowed('nope', 'image/png'), 'unknown kind carries nothing');
	assert.ok(AUDIO_MIMES.has('audio/mp4') && IMAGE_MIMES.has('image/jpeg'));
}

// (b) no range → serve it whole (200). Same for anything we decline to parse.
{
	assert.equal(parseRange(null, 100), null);
	assert.equal(parseRange('', 100), null);
	assert.equal(parseRange('items=0-10', 100), null, 'only the bytes unit');
	assert.equal(parseRange('bytes=abc', 100), null);
	assert.equal(parseRange('bytes=-', 100), null, 'neither form');
	assert.equal(parseRange('bytes=0-9,20-29', 100), null, 'multi-range: serve it whole');
	assert.equal(parseRange('bytes=0-1', 0), null, 'empty entity has no ranges');
}

// (c) the iOS opening probe, and normal explicit ranges.
{
	assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 }, 'the Safari probe');
	assert.deepEqual(parseRange(' bytes=0-1 ', 100), { start: 0, end: 1 }, 'tolerates padding');
	assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
	assert.deepEqual(parseRange('bytes=0-0', 100), { start: 0, end: 0 }, 'one byte');
	assert.deepEqual(parseRange('bytes=99-99', 100), { start: 99, end: 99 }, 'last byte');
}

// (d) open-ended and suffix forms.
{
	assert.deepEqual(parseRange('bytes=50-', 100), { start: 50, end: 99 }, 'to the end');
	assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 }, 'the whole thing');
	assert.deepEqual(parseRange('bytes=-20', 100), { start: 80, end: 99 }, 'last 20 bytes');
	assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 }, 'suffix past the start clamps');
}

// (e) an end past the entity is CLAMPED, not rejected — players seek to the end
//     of a clip constantly and a 416 there would stop playback dead.
{
	assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
	assert.deepEqual(parseRange('bytes=0-99999', 100), { start: 0, end: 99 });
}

// (f) genuinely unsatisfiable → 416, not a silent full body.
{
	assert.equal(parseRange('bytes=100-200', 100), 'unsatisfiable', 'starts at the end');
	assert.equal(parseRange('bytes=500-', 100), 'unsatisfiable', 'starts past the end');
	assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable', 'last zero bytes');
	assert.equal(parseRange('bytes=50-10', 100), 'unsatisfiable', 'end before start');
}

console.log('media-check: all assertions passed');

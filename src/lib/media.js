// Chat media: the shared upload contract (kinds, mime whitelist, size ceiling)
// plus the browser-side capture helpers. The constants are imported by the
// server routes too, so nothing at module level may touch `document`/`window`.

export const MEDIA_KINDS = new Set(['image', 'voice']);
export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const AUDIO_MIMES = new Set(['audio/webm', 'audio/mp4']);
// Same ceiling the avatar upload uses. base64 is ~4/3 of the bytes, so this is
// roughly a 1.1MB file — well above a 1280px JPEG or a 60s Opus clip.
export const MAX_BASE64 = 1_500_000;
export const MAX_VOICE_MS = 60_000;

/**
 * base64 → bytes, without `Buffer`.
 *
 * Buffer does not exist on a Workers runtime, and enabling nodejs_compat purely
 * for two decodes would also make the bundler more likely to resolve OTHER
 * packages to their Node builds (Ably ships one that pulls `https`/`got`/`ws`).
 * `atob` is present on every runtime this app targets.
 *
 * The whitespace strip is load-bearing, not defensive noise: Buffer.from
 * silently ignored newlines in a base64 string, and atob throws on them. Odoo
 * returns binary fields base64-encoded over JSON-RPC and is entitled to wrap
 * them, so dropping this would turn a working avatar into a 500 at runtime.
 */
export function b64ToBytes(b64) {
	const bin = atob(String(b64 || '').replace(/\s+/g, ''));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** The mime a `kind` is allowed to carry. Pure — shared by client and server. */
export function mimeAllowed(kind, mime) {
	if (kind === 'image') return IMAGE_MIMES.has(mime);
	if (kind === 'voice') return AUDIO_MIMES.has(mime);
	return false;
}

/**
 * Parse a `Range` request header against a known entity size.
 *
 * Lives here rather than in the media route because it's pure and wants direct
 * testing (see media-check.js) — the route itself can't be imported outside a
 * SvelteKit build.
 *
 * Returns:
 *   null             → serve the whole entity with 200. Covers "no Range", a
 *                      unit other than bytes, a malformed value, and multi-range
 *                      requests, all of which the spec lets a server ignore.
 *   'unsatisfiable'  → must be a 416; the range is well-formed but off the end.
 *   { start, end }   → inclusive byte offsets for a 206.
 */
export function parseRange(header, total) {
	if (!header || !(total > 0)) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
	if (!m) return null; // includes multi-range "bytes=0-9,20-29"
	const [, rawStart, rawEnd] = m;
	let start, end;
	if (rawStart === '') {
		// suffix form: the LAST n bytes
		if (rawEnd === '') return null; // "bytes=-" is neither form
		const n = Number(rawEnd);
		if (n === 0) return 'unsatisfiable';
		start = Math.max(0, total - n);
		end = total - 1;
	} else {
		start = Number(rawStart);
		if (start >= total) return 'unsatisfiable';
		end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
		if (end < start) return 'unsatisfiable';
	}
	return { start, end };
}

/* ------------------------------ browser only ------------------------------ */

const IMAGE_MAX_EDGE = 1280;
const IMAGE_QUALITY = 0.82;

/**
 * Downscale a picked photo to something a chat bubble can carry.
 *
 * Aspect-preserving, unlike the avatar's `resize()` in /profile — that one
 * centre-crops to a square, which would lop the top off a group photo.
 */
export function resizeImage(file) {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			try {
				const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
				const c = document.createElement('canvas');
				c.width = Math.max(1, Math.round(img.width * scale));
				c.height = Math.max(1, Math.round(img.height * scale));
				c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
				resolve({
					dataBase64: c.toDataURL('image/jpeg', IMAGE_QUALITY).split(',')[1],
					mime: 'image/jpeg',
					w: c.width,
					h: c.height
				});
			} catch (e) {
				reject(e);
			}
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('That file is not an image we can read'));
		};
		img.src = url;
	});
}

/** base64 → Blob, so a just-picked photo can be previewed without a round trip. */
export function base64ToBlob(dataBase64, mime) {
	const bin = atob(dataBase64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}

/**
 * The recording container this browser will actually produce, or null when it
 * can't record at all (the mic button hides in that case).
 *
 * mp4/aac is tried FIRST even though Opus is the better codec, because the clip
 * has to play on everyone ELSE's device, not just ours: iOS Safari can't decode
 * WebM/Opus at all, so a Chrome-recorded WebM note is silently dead for every
 * iPhone in the room. mp4/aac plays everywhere. Browsers that can't record mp4
 * (Firefox, older Chrome) fall through to Opus as before — those clips stay
 * unplayable on iOS, which is why ChatPanel says so out loud instead of just
 * rendering a dead player.
 */
export function pickAudioMime() {
	if (typeof MediaRecorder === 'undefined') return null;
	for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
		if (MediaRecorder.isTypeSupported(m)) return m;
	}
	return null;
}

/** The bare container type, without the codecs= parameter (what we store). */
function baseMime(m) {
	return String(m).split(';')[0];
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result).split(',')[1]);
		fr.onerror = () => reject(new Error('Could not read the recording'));
		fr.readAsDataURL(blob);
	});
}

/**
 * Press-to-record voice clips.
 *
 * `borrowMic` hands back the voice mesh's existing capture when the user is in
 * live voice: opening a SECOND getUserMedia while one is live misbehaves on
 * some mobile browsers. A borrowed stream is never stopped here — the mesh owns
 * it. A stream we opened ourselves is released as soon as the clip is done, so
 * the browser's recording indicator doesn't stay lit.
 */
export function createVoiceRecorder({ borrowMic } = {}) {
	let rec = null;
	let chunks = [];
	let ownStream = null;
	let startedAt = 0;
	let autoStop = null;
	let settle = null; // resolve of the promise stop() is waiting on

	function release() {
		clearTimeout(autoStop);
		autoStop = null;
		rec = null;
		chunks = [];
		if (ownStream) {
			for (const t of ownStream.getTracks()) t.stop();
			ownStream = null;
		}
	}

	async function start(onAutoStop) {
		if (rec) return;
		const mime = pickAudioMime();
		if (!mime) throw new Error('Recording is not supported in this browser');
		let stream = (await borrowMic?.()) || null;
		if (!stream) stream = ownStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		chunks = [];
		try {
			// Explicit bitrate, not the browser default: Safari's AAC can pick
			// 128–256kbps, and a full 60s at that blows MAX_BASE64 — the user would
			// record a whole minute only to be told it's too large. 64kbps caps the
			// worst case at ~480KB, and voice at that rate is perfectly clear.
			rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
		} catch (e) {
			release(); // don't leave a capture we opened running with no recorder
			throw e;
		}
		rec.ondataavailable = (e) => {
			if (e.data?.size) chunks.push(e.data);
		};
		rec.onstop = async () => {
			const dur = Math.round((Date.now() - startedAt) / 1000);
			const blob = new Blob(chunks, { type: baseMime(mime) });
			const done = settle;
			settle = null;
			release();
			if (!done) return;
			if (!blob.size) return done(null);
			try {
				done({ dataBase64: await blobToBase64(blob), mime: baseMime(mime), dur, blob });
			} catch {
				done(null);
			}
		};
		startedAt = Date.now();
		rec.start();
		// hard cap, enforced again server-side by the byte ceiling
		autoStop = setTimeout(() => onAutoStop?.(), MAX_VOICE_MS);
	}

	/** Stop and resolve with the clip (or null if it captured nothing). */
	function stop() {
		if (!rec) return Promise.resolve(null);
		return new Promise((resolve) => {
			settle = resolve;
			try {
				rec.stop();
			} catch {
				release();
				resolve(null);
			}
		});
	}

	/** Abandon the recording — nothing is returned to the caller. */
	function cancel() {
		if (!rec) return;
		settle = null;
		try {
			rec.stop();
		} catch {
			/* already dead */
		}
		release();
	}

	return { start, stop, cancel, get recording() { return !!rec; } };
}

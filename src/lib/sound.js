// Tiny synthesized SFX — no assets, no dependency, nothing to precache in the
// service worker. Kept deliberately quiet so it never fights the WebRTC voice
// chat that may be running in the same room.

const STORAGE_KEY = 'gr.sound';
const MASTER_GAIN = 0.15;

let ctx = null;
let unlockBound = false;

function browser() {
	return typeof window !== 'undefined';
}

/** Autoplay policy: an AudioContext can't start until a user gesture. We bind
 *  once, globally, so *observers* get sound too — not just whoever clicked.
 *  Listeners are `once` and passive; they cost nothing after firing. */
function bindUnlock() {
	if (unlockBound || !browser()) return;
	unlockBound = true;
	const unlock = () => audio(); // creates + resumes on the first real gesture
	for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
		window.addEventListener(ev, unlock, { once: true, passive: true });
	}
}

/** Arm the unlock listener ahead of time. Call this on mount: if we waited
 *  until the first sound was due, a player who hadn't clicked since page load
 *  would silently miss it — the gesture has to come first. */
export function arm() {
	bindUnlock();
}

function audio() {
	if (!browser()) return null;
	if (!ctx) {
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		try {
			ctx = new AC();
		} catch {
			return null;
		}
	}
	bindUnlock();
	if (ctx.state === 'suspended') ctx.resume().catch(() => {});
	return ctx;
}

export function isMuted() {
	if (!browser()) return false;
	try {
		return localStorage.getItem(STORAGE_KEY) === 'off';
	} catch {
		return false;
	}
}

export function setMuted(v) {
	if (!browser()) return;
	try {
		localStorage.setItem(STORAGE_KEY, v ? 'off' : 'on');
	} catch {
		/* private mode — mute just won't persist */
	}
}

/**
 * One shaped tone. Gain uses exponential ramps (never to exactly 0, which is
 * undefined for exponentialRampToValueAtTime) so notes don't click.
 */
function tone(ac, { at = 0, freq, endFreq, dur, type = 'triangle', gain = 1 }) {
	const t0 = ac.currentTime + at;
	const osc = ac.createOscillator();
	const amp = ac.createGain();
	osc.type = type;
	osc.frequency.setValueAtTime(freq, t0);
	if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);

	const peak = MASTER_GAIN * gain;
	amp.gain.setValueAtTime(0.0001, t0);
	amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.012); // fast attack
	amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

	osc.connect(amp).connect(ac.destination);
	osc.start(t0);
	osc.stop(t0 + dur + 0.02);
}

/** Caught the thief — bright rising arpeggio (E5 → A5 → E6). */
export function playCorrect() {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	tone(ac, { at: 0.0, freq: 659.25, dur: 0.14 });
	tone(ac, { at: 0.1, freq: 880.0, dur: 0.14 });
	tone(ac, { at: 0.2, freq: 1318.5, dur: 0.3, gain: 0.9 });
}

/** Wrong guess — low descending buzz. */
export function playWrong() {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	tone(ac, { freq: 220, endFreq: 155, dur: 0.4, type: 'sawtooth', gain: 0.55 });
	tone(ac, { at: 0.06, freq: 146.83, endFreq: 110, dur: 0.36, type: 'square', gain: 0.3 });
}

/**
 * Turn passed with nothing to do — a soft two-note sigh. Deliberately gentler
 * than playWrong: rolling a 3 with every token still in the yard is the game
 * working normally, not a mistake anyone made.
 */
export function playPass() {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	tone(ac, { at: 0.0, freq: 392.0, dur: 0.11, type: 'sine', gain: 0.5 });
	tone(ac, { at: 0.08, freq: 293.66, dur: 0.18, type: 'sine', gain: 0.42 });
}

/** Ludo dice roll — a short dry rattle of clipped blips. */
export function playDice() {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	for (let i = 0; i < 4; i++) {
		tone(ac, { at: i * 0.05, freq: 320 + Math.random() * 240, dur: 0.05, type: 'square', gain: 0.4 });
	}
}

/**
 * A piece landing on its square — a dry wooden knock.
 *
 * Two layers: a short low body that drops in pitch (the weight of the piece)
 * and a much quieter, faster click on top (the felt hitting the board). Kept
 * under 80ms so a fast exchange doesn't smear into one drone.
 */
export function playMove() {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	tone(ac, { freq: 300, endFreq: 150, dur: 0.075, type: 'triangle', gain: 0.75 });
	tone(ac, { at: 0.005, freq: 1200, endFreq: 600, dur: 0.035, type: 'square', gain: 0.22 });
}

/** Took a piece — a punchy downward thwack. Shared by ludo and chess. */
export function playCapture() {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	tone(ac, { freq: 440, endFreq: 120, dur: 0.22, type: 'sawtooth', gain: 0.6 });
}

/* ------------------------------- carroms ---------------------------------- */

/** 0..1 from a sim impact speed. Shots run ~10–40 units, so 24 is a hard hit. */
function impact(speed) {
	return Math.max(0.15, Math.min(1, (speed || 0) / 24));
}

/** The flick itself — a short bright snap, brighter the harder you pulled back. */
export function playCarromFlick(power = 0.6) {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	const k = Math.max(0.15, Math.min(1, power));
	tone(ac, { freq: 900 + k * 700, endFreq: 300, dur: 0.06, type: 'square', gain: 0.3 + k * 0.3 });
	tone(ac, { at: 0.004, freq: 240, endFreq: 120, dur: 0.09, type: 'triangle', gain: 0.35 });
}

/**
 * Two discs meeting — a hard little click. Deliberately shorter than the chess
 * knock: a break can fire a dozen of these in under a second, and anything with
 * a tail smears them into one buzz.
 */
export function playCarromHit(speed) {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	const k = impact(speed);
	tone(ac, { freq: 1100 + k * 900, endFreq: 500, dur: 0.028, type: 'square', gain: 0.18 + k * 0.3 });
	tone(ac, { at: 0.003, freq: 420 + k * 200, endFreq: 200, dur: 0.045, type: 'triangle', gain: 0.2 + k * 0.2 });
}

/** Off the cushion — same gesture, lower and duller than a disc-on-disc click. */
export function playCarromWall(speed) {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	const k = impact(speed);
	tone(ac, { freq: 200 + k * 120, endFreq: 90, dur: 0.07, type: 'triangle', gain: 0.16 + k * 0.22 });
}

/** Down the hole — a coin drops; the queen gets a brighter two-note flourish. */
export function playCarromPocket(kind = 'coin') {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	if (kind === 'queen') {
		tone(ac, { at: 0.0, freq: 784.0, dur: 0.13 });
		tone(ac, { at: 0.09, freq: 1174.7, dur: 0.26, gain: 0.9 });
		return;
	}
	tone(ac, { freq: 520, endFreq: 180, dur: 0.16, type: 'triangle', gain: 0.7 });
	tone(ac, { at: 0.05, freq: 150, endFreq: 80, dur: 0.16, type: 'sine', gain: 0.5 });
}

/** Your own striker went down — a flat, unhappy buzz. */
export function playCarromFoul() {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	tone(ac, { freq: 165, endFreq: 98, dur: 0.42, type: 'square', gain: 0.45 });
	tone(ac, { at: 0.08, freq: 123.5, endFreq: 82, dur: 0.34, type: 'sawtooth', gain: 0.28 });
}

/** Brought a token home — bright two-note chime (C6 → G6). */
export function playHome() {
	if (isMuted()) return;
	const ac = audio();
	if (!ac) return;
	tone(ac, { at: 0.0, freq: 1046.5, dur: 0.16 });
	tone(ac, { at: 0.12, freq: 1568.0, dur: 0.28, gain: 0.9 });
}

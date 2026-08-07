// WebRTC mesh voice manager. Signaling rides the room poll (offer/answer/ice
// events targeted per-user server-side). Glare avoidance: for any pair, the
// LOWER uid is always the offerer — deterministic, no perfect-negotiation dance.
// ICE servers come from /api/turn: Cloudflare TURN credentials minted
// server-side (short-lived), STUN-only fallback when TURN isn't configured.
const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const ICE_FLUSH_MS = 300; // batch outgoing candidates into one POST per tick

// Also drives the video-call room: pass `video: true` and an `onStream(uid, stream)`
// callback and each peer's media is handed to the caller to bind to a <video>
// (which plays its audio too), instead of the hidden <Audio> the voice bar uses.
export function createVoiceMesh({ myUid, sendSignal, onPeersChange, onStream = null, video = false }) {
	const peers = new Map(); // uid -> { pc, audioEl, pendingIce, outIce, flushTimer, createdAt }
	/* uid -> candidates that arrived before we had a peer for them.
	   They used to be dropped on the floor, which cost a full 15s STALE_MS cycle to
	   recover from. The race is real for the higher-uid side, which has no peer
	   object at all until the offer lands — and sending the first candidate straight
	   away (see queueIce) makes ICE-before-offer MORE likely, not less. Bounded,
	   because a uid that never follows up with an offer must not grow this forever. */
	const earlyIce = new Map();
	const EARLY_ICE_MAX = 30;
	let localStream = null;
	// Which camera the current video track came from, so flipCamera knows what to
	// ask for next and ensureMic re-opens the one the user chose after a rejoin.
	let facing = 'user';
	// Mirrored from setCameraOff. Lives HERE rather than in the component because
	// a flip acquires a fresh track, and a fresh track arrives enabled — without
	// this, flipping would silently un-blank a camera the user turned off.
	let camOff = false;
	let joined = false;
	let iceServers = FALLBACK_ICE;
	// signals arriving while getUserMedia/permission prompt is still up would
	// otherwise be lost forever (the offerer never re-sends) — buffer them
	let preJoinSignals = [];

	/** [{uid, state}] — VoiceBar derives "connecting…" from real pc states. */
	function notify() {
		onPeersChange?.(
			[...peers.entries()].map(([uid, p]) => ({ uid, state: p.pc.connectionState }))
		);
	}

	async function ensureMic() {
		if (!localStream) {
			// Explicit AEC/NS/AGC: `audio: true` leaves them to the UA default, which
			// is why the remote's voice off the speaker leaked back as echo. Asking
			// for them turns the browser's echo canceller on for the capture.
			localStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
				// Soft (non-`exact`) facingMode: a desktop webcam that reports no facing
				// mode is unaffected, and the voice-only mesh still passes plain `false`.
				// flipCamera uses `exact` — there it has to actually change the device.
				video: video ? { facingMode: facing } : false
			});
		}
		return localStream;
	}

	function playRemote(entry, stream) {
		if (!entry.audioEl) {
			entry.audioEl = new Audio();
			entry.audioEl.autoplay = true;
			entry.audioEl.setAttribute('playsinline', '');
		}
		entry.audioEl.srcObject = stream;
		entry.audioEl.play().catch(() => {
			// autoplay blocked — retry on the next user gesture
			const retry = () => {
				entry.audioEl?.play().catch(() => {});
				document.removeEventListener('click', retry);
				document.removeEventListener('touchend', retry);
			};
			document.addEventListener('click', retry, { once: true });
			document.addEventListener('touchend', retry, { once: true });
		});
	}

	function queueIce(uid, entry, candidate) {
		entry.outIce.push(candidate);
		/* The FIRST candidate goes out immediately; only the tail is batched.
		   The timer used to be armed by the first candidate rather than debounced
		   from the last, so the host/srflx candidate — the one most likely to be
		   half of the winning pair — was held 300ms on each side. A connectivity
		   check needs both ends, so that was an unconditional tax on the fastest
		   possible path, paid on every single connection. */
		if (!entry.sentFirstIce) {
			entry.sentFirstIce = true;
			sendSignal(uid, 'ice', { candidates: entry.outIce.splice(0) });
			return;
		}
		if (!entry.flushTimer) {
			entry.flushTimer = setTimeout(() => {
				entry.flushTimer = null;
				const candidates = entry.outIce.splice(0);
				if (candidates.length) sendSignal(uid, 'ice', { candidates });
			}, ICE_FLUSH_MS);
		}
	}

	function newPeer(uid) {
		const pc = new RTCPeerConnection({ iceServers });
		const entry = { pc, audioEl: null, pendingIce: [], outIce: [], flushTimer: null, sentFirstIce: false, createdAt: Date.now() };
		// Candidates that beat the offer here have been waiting for this object —
		// see earlyIce. They belong to the negotiation we are about to run, so they
		// go on the same queue the pre-remoteDescription candidates use.
		const early = earlyIce.get(uid);
		if (early) {
			entry.pendingIce.push(...early);
			earlyIce.delete(uid);
		}
		for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
		pc.onicecandidate = (e) => {
			if (e.candidate) queueIce(uid, entry, e.candidate);
		};
		// video mode hands the stream to the component (a <video> plays its audio);
		// voice mode plays it through a hidden <Audio> as before
		pc.ontrack = (e) => (onStream ? onStream(uid, e.streams[0]) : playRemote(entry, e.streams[0]));
		pc.onconnectionstatechange = () => {
			// 'disconnected' is transient — only tear down on hard failure; the
			// roster-driven sync() then rebuilds the pair (lower uid re-offers)
			if (['failed', 'closed'].includes(pc.connectionState)) drop(uid);
			else notify();
		};
		peers.set(uid, entry);
		notify();
		return entry;
	}

	async function offerTo(uid) {
		const entry = newPeer(uid);
		const offer = await entry.pc.createOffer();
		await entry.pc.setLocalDescription(offer);
		sendSignal(uid, 'offer', { sdp: entry.pc.localDescription });
	}

	function drop(uid) {
		// Whatever was held for a peer that never materialised belongs to a
		// negotiation that is now over. Cleared even when there is no entry, so a
		// `bye` from someone we never connected to still tidies up.
		earlyIce.delete(uid);
		const entry = peers.get(uid);
		if (!entry) return;
		clearTimeout(entry.flushTimer);
		try {
			entry.pc.close();
		} catch {}
		if (entry.audioEl) entry.audioEl.srcObject = null;
		peers.delete(uid);
		notify();
	}

	const STALE_MS = 15000;

	/** Reconcile connections with the server's voice roster. */
	async function sync(voiceUids) {
		if (!joined) return;
		const others = voiceUids.filter((u) => u !== myUid);
		// watchdog: a pair stuck negotiating (lost signal, failed relay path)
		// gets torn down; the offerer immediately re-offers below
		for (const [uid, entry] of peers) {
			const stuck =
				['new', 'connecting'].includes(entry.pc.connectionState) &&
				Date.now() - entry.createdAt > STALE_MS;
			if (stuck) drop(uid);
		}
		for (const uid of others) {
			// lower uid offers; the higher side waits for the offer to arrive
			if (!peers.has(uid) && myUid < uid) await offerTo(uid);
		}
		for (const uid of [...peers.keys()]) {
			if (!others.includes(uid)) drop(uid);
		}
	}

	async function addIce(entry, data) {
		// accepts both shapes: {candidates:[...]} (batched) and {candidate} (legacy)
		const list = data.candidates || (data.candidate ? [data.candidate] : []);
		for (const c of list) {
			if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(c).catch(() => {});
			else entry.pendingIce.push(c);
		}
	}

	async function handleSignal(fromUid, { kind, data }) {
		if (!joined) {
			// mic permission prompt still up — keep for processing after join
			preJoinSignals.push([fromUid, { kind, data }]);
			return;
		}
		if (kind === 'bye') return drop(fromUid);
		let entry = peers.get(fromUid);
		if (kind === 'offer') {
			if (entry) drop(fromUid); // stale pc — restart from their offer
			entry = newPeer(fromUid);
			await entry.pc.setRemoteDescription(data.sdp);
			const answer = await entry.pc.createAnswer();
			await entry.pc.setLocalDescription(answer);
			sendSignal(fromUid, 'answer', { sdp: entry.pc.localDescription });
			for (const c of entry.pendingIce.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
		} else if (kind === 'answer' && entry) {
			await entry.pc.setRemoteDescription(data.sdp);
			for (const c of entry.pendingIce.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
		} else if (kind === 'ice') {
			if (entry) await addIce(entry, data);
			else {
				// No peer object yet — hold them for the offer that is on its way rather
				// than discarding, which used to cost a 15s watchdog cycle to recover.
				const list = data.candidates || (data.candidate ? [data.candidate] : []);
				const held = earlyIce.get(fromUid) || [];
				earlyIce.set(fromUid, [...held, ...list].slice(-EARLY_ICE_MAX));
			}
		}
	}

	async function fetchIce() {
		try {
			const res = await fetch('/api/turn');
			const d = await res.json();
			if (d?.iceServers?.length) iceServers = d.iceServers;
		} catch {
			iceServers = FALLBACK_ICE;
		}
	}

	async function join() {
		/* IN PARALLEL, not one after the other. These share no data — iceServers is
		   read only when the first RTCPeerConnection is constructed, well after both
		   have settled — and ensureMic can sit on an OS permission prompt for as long
		   as the user takes to look at it. Waiting all of that out before so much as
		   issuing the credential fetch put the whole TURN round trip on the critical
		   path for no reason. */
		await Promise.all([ensureMic(), fetchIce()]);
		joined = true;
		// replay anything that arrived during the permission prompt
		const buffered = preJoinSignals.splice(0);
		for (const [uid, sig] of buffered) await handleSignal(uid, sig);
	}

	function leave() {
		joined = false;
		preJoinSignals = [];
		earlyIce.clear();
		for (const uid of [...peers.keys()]) {
			try {
				sendSignal(uid, 'bye', {});
			} catch {}
			drop(uid);
		}
		if (localStream) {
			for (const t of localStream.getTracks()) t.stop();
			localStream = null;
		}
	}

	function setMuted(muted) {
		if (!localStream) return;
		for (const t of localStream.getAudioTracks()) t.enabled = !muted;
	}

	/** Camera on/off for the video room — toggles the local video track's `enabled`,
	 *  which every peer sees go black without renegotiating. */
	function setCameraOff(off) {
		// Remembered even with no stream yet, so it survives a flip (which opens a
		// brand-new, enabled track) and a rejoin.
		camOff = off;
		if (!localStream) return;
		for (const t of localStream.getVideoTracks()) t.enabled = !off;
	}

	/** The other camera's deviceId, for the fallback in flipCamera. */
	async function otherCameraId(currentId) {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const cams = devices.filter((d) => d.kind === 'videoinput');
		if (cams.length < 2) return null;
		const i = cams.findIndex((d) => d.deviceId === currentId);
		return cams[(i + 1) % cams.length]?.deviceId ?? null;
	}

	/**
	 * Swap the local camera between front and back.
	 *
	 * NO RENEGOTIATION: a same-kind replaceTrack does not fire `negotiationneeded`,
	 * so every peer just starts seeing the other camera mid-call. Returns the new
	 * facing mode ('user' | 'environment'), or null if there was nothing to flip.
	 *
	 * Has to live in here rather than in the component: the senders are never
	 * retained and `peers` is closure-private, so there is no way to reach an
	 * RTCRtpSender from outside.
	 */
	async function flipCamera() {
		if (!video || !localStream) return null;
		const oldTrack = localStream.getVideoTracks()[0];
		if (!oldTrack) return null;

		const next = facing === 'user' ? 'environment' : 'user';
		const oldId = oldTrack.getSettings?.().deviceId;
		/* STOP THE OLD TRACK FIRST. Holding two camera captures open at once
		   misbehaves on iOS — the same hazard media.js documents for the mic — so
		   the release has to precede the acquire, and the cost is that a failure
		   below leaves us with no camera until the rollback re-opens one. */
		oldTrack.stop();

		const open = (constraints) =>
			navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });

		let fresh;
		try {
			// `exact` on purpose. A soft { facingMode: next } is NOT a usable fallback:
			// the browser is free to hand back the very same camera and report success,
			// so the user taps Flip, nothing changes, and nothing reports an error.
			// Cycling deviceId is the honest second attempt.
			try {
				fresh = await open({ facingMode: { exact: next } });
			} catch {
				const id = await otherCameraId(oldId);
				if (!id) throw new Error('No second camera available');
				fresh = await open({ deviceId: { exact: id } });
			}
		} catch (e) {
			// Put the camera we just stopped back, so a failed flip costs a flicker
			// rather than the rest of the call. This is a fresh acquisition too and
			// can fail in turn — then the stream is audio-only and the caller is told.
			try {
				const back = await open({ facingMode: facing });
				await adoptVideoTrack(oldTrack, back.getVideoTracks()[0]);
			} catch {
				localStream.removeTrack(oldTrack);
			}
			throw e;
		}

		await adoptVideoTrack(oldTrack, fresh.getVideoTracks()[0]);
		facing = next;
		return facing;
	}

	/**
	 * Put `newTrack` in `oldTrack`'s place, everywhere it needs to be.
	 *
	 * The local stream is mutated IN PLACE rather than replaced wholesale, and that
	 * is load-bearing twice over: newPeer re-reads localStream.getTracks() for every
	 * peer that arrives later, so a swapped-out stream object would hand a late
	 * joiner the old stopped track; and the component is holding this exact object
	 * as its <video> srcObject.
	 */
	async function adoptVideoTrack(oldTrack, newTrack) {
		if (!newTrack) return;
		newTrack.enabled = !camOff; // a fresh track is enabled — honour camera-off
		localStream.removeTrack(oldTrack);
		localStream.addTrack(newTrack);
		await Promise.all(
			[...peers.values()].map((p) =>
				p.pc
					.getSenders()
					.find((s) => s.track?.kind === 'video')
					?.replaceTrack(newTrack)
					// one dead peer must not abort the swap for the rest
					?.catch(() => {})
			)
		);
	}

	/** The local capture, for the video room's own self-preview tile. */
	function getLocalStream() {
		return localStream;
	}

	/**
	 * The live capture, for anything else that needs the mic (chat voice
	 * messages) — never opens one, so a caller can tell "already capturing" from
	 * "not in voice". Muted means every track is disabled, and a recording off a
	 * disabled track is silence, so that reads as no stream too: the borrower
	 * opens its own instead.
	 */
	function micStream() {
		return localStream?.getAudioTracks().some((t) => t.enabled) ? localStream : null;
	}

	/** Is the capture still live? A phone that suspended the page on screen-lock can
	 *  end the mic track (readyState 'ended'); the stream object lingers but carries
	 *  no audio, so the caller re-arms by rejoining. */
	function micLive() {
		return !!localStream && localStream.getAudioTracks().some((t) => t.readyState === 'live');
	}

	return { join, leave, sync, handleSignal, setMuted, setCameraOff, flipCamera, getLocalStream, micStream, micLive, get joined() { return joined; } };
}

/**
 * Does this device have a camera to flip TO?
 *
 * Call it after the mesh has joined: before permission is granted some browsers
 * report a single placeholder videoinput, so asking too early hides the button
 * on a phone that has two. False on any failure — a missing flip button is a far
 * better outcome than one that can't work.
 */
export async function hasMultipleCameras() {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((d) => d.kind === 'videoinput').length >= 2;
	} catch {
		return false;
	}
}

// WebRTC mesh voice manager. Signaling rides the room poll (offer/answer/ice
// events targeted per-user server-side). Glare avoidance: for any pair, the
// LOWER uid is always the offerer — deterministic, no perfect-negotiation dance.
// ICE servers come from /api/turn: Cloudflare TURN credentials minted
// server-side (short-lived), STUN-only fallback when TURN isn't configured.
const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const ICE_FLUSH_MS = 300; // batch outgoing candidates into one POST per tick

export function createVoiceMesh({ myUid, sendSignal, onPeersChange }) {
	const peers = new Map(); // uid -> { pc, audioEl, pendingIce, outIce, flushTimer, createdAt }
	let localStream = null;
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
			localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
		const entry = { pc, audioEl: null, pendingIce: [], outIce: [], flushTimer: null, createdAt: Date.now() };
		for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
		pc.onicecandidate = (e) => {
			if (e.candidate) queueIce(uid, entry, e.candidate);
		};
		pc.ontrack = (e) => playRemote(entry, e.streams[0]);
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
		} else if (kind === 'ice' && entry) {
			await addIce(entry, data);
		}
	}

	async function join() {
		await ensureMic();
		try {
			const res = await fetch('/api/turn');
			const d = await res.json();
			if (d?.iceServers?.length) iceServers = d.iceServers;
		} catch {
			iceServers = FALLBACK_ICE;
		}
		joined = true;
		// replay anything that arrived during the permission prompt
		const buffered = preJoinSignals.splice(0);
		for (const [uid, sig] of buffered) await handleSignal(uid, sig);
	}

	function leave() {
		joined = false;
		preJoinSignals = [];
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

	return { join, leave, sync, handleSignal, setMuted, get joined() { return joined; } };
}

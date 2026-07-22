// WebRTC mesh voice manager. Signaling rides the room poll (offer/answer/ice
// events targeted per-user server-side). Glare avoidance: for any pair, the
// LOWER uid is always the offerer — deterministic, no perfect-negotiation dance.
// ponytail: STUN only; symmetric-NAT pairs won't connect — add TURN when reported.
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export function createVoiceMesh({ myUid, sendSignal, onPeersChange }) {
	const peers = new Map(); // uid -> { pc, audioEl, pendingIce: [] }
	let localStream = null;
	let joined = false;

	function notify() {
		onPeersChange?.([...peers.keys()]);
	}

	async function ensureMic() {
		if (!localStream) {
			localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		}
		return localStream;
	}

	function newPeer(uid) {
		const pc = new RTCPeerConnection({ iceServers: ICE });
		const entry = { pc, audioEl: null, pendingIce: [] };
		for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
		pc.onicecandidate = (e) => {
			if (e.candidate) sendSignal(uid, 'ice', { candidate: e.candidate });
		};
		pc.ontrack = (e) => {
			if (!entry.audioEl) {
				entry.audioEl = new Audio();
				entry.audioEl.autoplay = true;
			}
			entry.audioEl.srcObject = e.streams[0];
		};
		pc.onconnectionstatechange = () => {
			if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
				// let the roster-driven sync() rebuild it if the peer is still in voice
				drop(uid);
			}
			notify();
		};
		peers.set(uid, entry);
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
		try {
			entry.pc.close();
		} catch {}
		if (entry.audioEl) entry.audioEl.srcObject = null;
		peers.delete(uid);
		notify();
	}

	/** Reconcile connections with the server's voice roster. */
	async function sync(voiceUids) {
		if (!joined) return;
		const others = voiceUids.filter((u) => u !== myUid);
		for (const uid of others) {
			// lower uid offers; the higher side waits for the offer to arrive
			if (!peers.has(uid) && myUid < uid) await offerTo(uid);
		}
		for (const uid of [...peers.keys()]) {
			if (!others.includes(uid)) drop(uid);
		}
	}

	async function handleSignal(fromUid, { kind, data }) {
		if (!joined) return;
		if (kind === 'bye') return drop(fromUid);
		let entry = peers.get(fromUid);
		if (kind === 'offer') {
			if (entry) drop(fromUid); // stale pc — restart from their offer
			entry = newPeer(fromUid);
			await entry.pc.setRemoteDescription(data.sdp);
			const answer = await entry.pc.createAnswer();
			await entry.pc.setLocalDescription(answer);
			sendSignal(fromUid, 'answer', { sdp: entry.pc.localDescription });
			for (const c of entry.pendingIce.splice(0)) await entry.pc.addIceCandidate(c);
		} else if (kind === 'answer' && entry) {
			await entry.pc.setRemoteDescription(data.sdp);
			for (const c of entry.pendingIce.splice(0)) await entry.pc.addIceCandidate(c);
		} else if (kind === 'ice' && entry) {
			if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate);
			else entry.pendingIce.push(data.candidate);
		}
	}

	async function join() {
		await ensureMic();
		joined = true;
	}

	function leave(voiceUids = []) {
		joined = false;
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

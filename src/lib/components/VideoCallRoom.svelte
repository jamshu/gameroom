<script>
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import Avatar from './Avatar.svelte';
	import { createVoiceMesh } from '$lib/webrtc.js';

	let { store, game, members, myUid } = $props();

	let mesh = null;
	let joined = $state(false);
	let error = $state('');
	let muted = $state(false);
	let camOff = $state(false);
	let localStream = $state(null);
	let peers = $state([]); // [{ uid, state }] from the mesh
	let streams = $state(new Map()); // uid -> MediaStream

	const nameOf = (uid) => members.find((m) => m.uid === uid)?.name || `#${uid}`;
	// everyone the server lists in the call except me — my tile is separate
	const others = $derived(($store.voice || []).filter((u) => u !== myUid));
	const stateOf = (uid) => peers.find((p) => p.uid === uid)?.state;

	/** Bind a MediaStream to a <video> without a reactive round trip. */
	function srcObject(node, stream) {
		node.srcObject = stream || null;
		return { update: (s) => (node.srcObject = s || null) };
	}

	onMount(async () => {
		mesh = createVoiceMesh({
			myUid,
			video: true,
			sendSignal: (toUid, kind, data) => store.post('signal', { toUid, kind, data }).catch(() => {}),
			onPeersChange: (p) => (peers = p),
			onStream: (uid, stream) => {
				streams.set(uid, stream);
				streams = new Map(streams);
			}
		});
		// single-subscriber: the room page hides its voice bar for this game type, so
		// nothing else is claiming the signal channel
		store.onSignal((from, payload) => mesh.handleSignal(from, payload));
		try {
			await mesh.join(); // camera + mic permission, then TURN creds
			localStream = mesh.getLocalStream();
			await store.post('voice', { action: 'join' });
			joined = true;
			mesh.sync($store.voice);
		} catch (e) {
			error = e?.message || 'Could not start your camera';
		}
	});

	// keep the mesh reconciled with the server's call roster
	$effect(() => {
		if (joined && mesh) mesh.sync($store.voice);
	});

	onDestroy(() => {
		mesh?.leave();
		store.post('voice', { action: 'leave' }).catch(() => {});
	});

	function toggleMute() {
		muted = !muted;
		mesh?.setMuted(muted);
	}
	function toggleCam() {
		camOff = !camOff;
		mesh?.setCameraOff(camOff);
	}
	async function leaveCall() {
		mesh?.leave();
		await store.post('voice', { action: 'leave' }).catch(() => {});
		goto('/');
	}
</script>

<div class="card vc">
	<div class="vc-head">
		<h2 class="section-title">📹 Video Call</h2>
		<span class="muted">{($store.voice?.length || 0)} on the call</span>
	</div>

	{#if error}
		<p class="error-text">{error} — check camera/mic permissions and reload.</p>
	{/if}

	<div class="vc-grid" style="--n:{others.length + 1}">
		<!-- your own preview -->
		<div class="tile tile--me">
			<!-- svelte-ignore a11y_media_has_caption -->
			<video use:srcObject={localStream} autoplay playsinline muted class:off={camOff}></video>
			{#if camOff}
				<div class="tile-avatar"><Avatar uid={myUid} name={nameOf(myUid)} size={64} /></div>
			{/if}
			<span class="tile-name">{nameOf(myUid)} (you){muted ? ' 🔇' : ''}</span>
		</div>

		{#each others as uid (uid)}
			<div class="tile">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video use:srcObject={streams.get(uid)} autoplay playsinline></video>
				{#if !streams.get(uid) || stateOf(uid) !== 'connected'}
					<div class="tile-avatar">
						<Avatar uid={uid} name={nameOf(uid)} size={64} />
						<span class="tile-status">{stateOf(uid) === 'failed' ? 'lost' : 'connecting…'}</span>
					</div>
				{/if}
				<span class="tile-name">{nameOf(uid)}</span>
			</div>
		{/each}
	</div>

	<div class="vc-controls">
		<button class="btn" class:btn--danger={muted} onclick={toggleMute}>
			{muted ? '🔇 Unmute' : '🎤 Mute'}
		</button>
		<button class="btn" class:btn--danger={camOff} onclick={toggleCam}>
			{camOff ? '📷 Camera on' : '🎥 Camera off'}
		</button>
		<button class="btn btn--danger" onclick={leaveCall}>✕ Leave call</button>
	</div>
</div>

<style>
	.vc {
		padding: 20px;
	}
	.vc-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}
	.section-title {
		margin: 0;
	}
	.vc-grid {
		display: grid;
		/* up to 6 tiles: 1 col for 1, 2 cols for 2-4, 3 cols beyond */
		grid-template-columns: repeat(var(--cols, 2), 1fr);
		gap: 10px;
	}
	@media (min-width: 640px) {
		.vc-grid {
			--cols: 3;
		}
	}
	.tile {
		position: relative;
		aspect-ratio: 4 / 3;
		background: #10131c;
		border-radius: var(--radius-sm, 10px);
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.tile video {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		background: #10131c;
	}
	.tile--me video {
		transform: scaleX(-1); /* mirror own preview, like every call app */
	}
	.tile video.off {
		visibility: hidden;
	}
	.tile-avatar {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		color: #cbd2e0;
	}
	.tile-status {
		font-size: 0.78rem;
		opacity: 0.75;
	}
	.tile-name {
		position: absolute;
		left: 8px;
		bottom: 6px;
		padding: 2px 8px;
		border-radius: 999px;
		background: rgba(10, 12, 18, 0.6);
		color: #fff;
		font-size: 0.78rem;
	}
	.vc-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 14px;
		justify-content: center;
	}
</style>

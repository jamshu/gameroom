<script>
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import Avatar from './Avatar.svelte';
	import { createVoiceMesh, hasMultipleCameras } from '$lib/webrtc.js';
	import { createFullscreen, portal } from '$lib/fullscreen.svelte.js';

	let { store, game, members, myUid } = $props();
	const roomId = $page.params.id;

	// A closed tab / OS back-swipe never runs onDestroy's async leave, so the room
	// keeps us in the call roster and everyone else sees a frozen "connecting" tile.
	// A sendBeacon on pagehide is the only thing that survives the page going away.
	function beaconLeave() {
		navigator.sendBeacon?.(`/api/rooms/${roomId}/voice`, JSON.stringify({ action: 'leave' }));
	}

	let mesh = null;
	let dropSignal = null; // releases the shared signal channel on unmount
	let joined = $state(false);
	let error = $state('');
	let muted = $state(false);
	let camOff = $state(false);
	// Front/back camera. `canFlip` stays false until we've actually seen two
	// cameras, so the button never appears where it could not work.
	let facing = $state('user');
	let canFlip = $state(false);
	let flipping = $state(false);
	let localStream = $state(null);
	let peers = $state([]); // [{ uid, state }] from the mesh
	let streams = $state(new Map()); // uid -> MediaStream

	const nameOf = (uid) => members.find((m) => m.uid === uid)?.name || `#${uid}`;
	const memberUids = $derived(new Set(members.map((m) => m.uid)));
	// The call roster, gated on current membership: a user who left the call or was
	// removed from the room can linger in the raw voice roster for a poll. Both the
	// tiles AND the mesh sync off THIS, so a ghost never gets a frozen tile and the
	// mesh never sits "connecting…" to someone who is gone.
	const callUids = $derived(($store.voice || []).filter((u) => memberUids.has(u)));
	// everyone on the call except me — my tile is separate
	const others = $derived(callUids.filter((u) => u !== myUid));
	const stateOf = (uid) => peers.find((p) => p.uid === uid)?.state;

	// Drop a departed peer's stream so it can't leave a frozen last frame behind
	// (and frees the object if they never come back).
	$effect(() => {
		const live = new Set(others);
		let changed = false;
		for (const uid of streams.keys()) {
			if (!live.has(uid)) {
				streams.delete(uid);
				changed = true;
			}
		}
		if (changed) streams = new Map(streams);
	});

	// Your own preview floats in the corner (PiP) by default so the others get the
	// whole stage — tap it to dock it into the grid, tap again to re-float. Alone in
	// the room there's nobody to give the stage to, so self just fills the grid.
	// Fullscreen always floats self as a small Google-Meet-style PiP so the remote
	// owns the screen; windowed, it floats by default but can dock into the grid.
	let selfDocked = $state(false);
	// 3 people (two remotes) reads best as two full-width halves stacked, with self
	// as a small square below — not a corner PiP over thin side-by-side strips.
	const stacked = $derived(others.length === 2);
	const floating = $derived(others.length > 0 && (fs.isFs || (!selfDocked && !stacked)));
	const selfBelow = $derived(!fs.isFs && stacked && !selfDocked); // small square under the halves
	const selfInGrid = $derived(!floating && !selfBelow); // docked, or alone in the room

	// Split HORIZONTALLY: tiles stack into rows (full-width bands) rather than thin
	// side-by-side columns. Up to 3 tiles = one column of stacked halves/thirds;
	// 4–6 fall back to two columns so the bands don't get too short.
	const gridCount = $derived(others.length + (selfInGrid ? 1 : 0));
	const cols = $derived(gridCount <= 3 ? 1 : 2);

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
		// Single-subscriber channel: the room page hides its voice bar for this game
		// type, so nothing else claims it while we are mounted — AND we must hand it
		// back on unmount (see onDestroy). Claiming without releasing is what left the
		// lobby's voice permanently stuck on "connecting…" after a call ended.
		dropSignal = store.onSignal((from, payload) => mesh.handleSignal(from, payload));
		try {
			await mesh.join(); // camera + mic permission, then TURN creds
			localStream = mesh.getLocalStream();
			await store.post('voice', { action: 'join' });
			joined = true;
			mesh.sync(callUids);
			// AFTER join, never before: until permission is granted some browsers
			// report a single placeholder camera, which would hide the button on a
			// phone that has two.
			canFlip = await hasMultipleCameras();
		} catch (e) {
			error = e?.message || 'Could not start your camera';
		}
		window.addEventListener('pagehide', beaconLeave);
	});

	// keep the mesh reconciled — to the MEMBER-gated roster, so it tears down any
	// peer who left the room but lingers in the raw voice roster (no more stuck
	// "connecting…" tile for someone who is gone)
	$effect(() => {
		if (joined && mesh) mesh.sync(callUids);
	});

	onDestroy(() => {
		window.removeEventListener('pagehide', beaconLeave);
		// BEFORE mesh.leave(), and not optional: a left mesh has joined === false, and
		// handleSignal on such a mesh swallows every signal into a buffer that only
		// join() drains — a call that never comes again once this component is gone.
		// Leaving the handler installed therefore black-holes the room's signalling
		// for the rest of the session.
		dropSignal?.();
		dropSignal = null;
		mesh?.leave();
		// beacon, not the async post: an onDestroy fired by navigation gets its
		// fetch cancelled mid-flight, and then the roster keeps the ghost
		beaconLeave();
	});

	function toggleMute() {
		muted = !muted;
		mesh?.setMuted(muted);
	}
	function toggleCam() {
		camOff = !camOff;
		mesh?.setCameraOff(camOff);
	}
	// Front <-> back. The mesh swaps the track into every peer connection without
	// renegotiating, so the call does not drop; all this has to track is which way
	// round we ended up, because that decides whether the self-preview is mirrored.
	async function flipCam() {
		if (flipping || !mesh) return;
		flipping = true;
		error = '';
		try {
			facing = (await mesh.flipCamera()) || facing;
		} catch (e) {
			error = e?.message || 'Could not switch camera';
		} finally {
			flipping = false;
		}
	}
	async function leaveCall() {
		mesh?.leave();
		await store.post('voice', { action: 'leave' }).catch(() => {});
		goto('/');
	}

	let stageEl = $state(null);
	const fs = createFullscreen(() => stageEl);

	// Ring an absent member's device (web push → opens this room → auto-joins).
	const absent = $derived(members.filter((m) => m.uid !== myUid && !callUids.includes(m.uid)));
	let ringing = $state(new Set());
	async function ring(uid) {
		ringing = new Set(ringing).add(uid);
		try {
			await store.post('call', { toUid: uid });
		} catch (e) {
			error = e?.message || 'Could not ring that user';
		}
		setTimeout(() => {
			const next = new Set(ringing);
			next.delete(uid);
			ringing = next;
		}, 4000);
	}
</script>

<div class="card vc">
	<div class="vc-head">
		<h2 class="section-title">📹 Video Call</h2>
		<span class="muted">{callUids.length} on the call</span>
	</div>

	{#if error}
		<p class="error-text">{error} — check camera/mic permissions and reload.</p>
	{/if}

	{#snippet selfInner()}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			use:srcObject={localStream}
			autoplay
			playsinline
			muted
			class:off={camOff}
			class:rear={facing === 'environment'}
		></video>
		{#if camOff}
			<div class="tile-avatar"><Avatar uid={myUid} name={nameOf(myUid)} size={floating ? 40 : 64} /></div>
		{/if}
	{/snippet}

	<div class="vc-stage" class:vc-stage--fs={fs.isFs} bind:this={stageEl} use:portal={fs.isFs}>
		<!-- the frame is the video area only: it anchors the floating PiP, so the PiP can
		     never reach the controls below no matter how many rows they wrap into -->
		<div class="vc-frame">
			<div class="vc-grid" style="--cols:{cols}">
				<!-- self docks in as the first grid tile (always floats in fullscreen) -->
				{#if selfInGrid}
					<button
						class="tile tile--me tile--self"
						aria-label="Your video"
						onclick={() => (selfDocked = !selfDocked)}
					>
						{@render selfInner()}
					</button>
				{/if}

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

			<!-- floating picture-in-picture self preview. Sibling of .vc-grid, never a child:
			     as a grid child it would match the fullscreen `height: 100%` fill rule below. -->
			{#if floating}
				<button
					class="tile tile--me tile--self tile--pip"
					aria-label="Your video"
					onclick={() => (selfDocked = !selfDocked)}
				>
					{@render selfInner()}
				</button>
			{/if}

			<!-- 3-person: self as a small square centred below the two stacked halves -->
			{#if selfBelow}
				<button
					class="tile tile--me tile--self tile--below"
					aria-label="Your video"
					onclick={() => (selfDocked = !selfDocked)}
				>
					{@render selfInner()}
				</button>
			{/if}
		</div>

		<!-- controls live INSIDE the stage so they travel into fullscreen with it -->
		<div class="vc-controls">
			<button class="btn" class:btn--danger={muted} onclick={toggleMute}>
				{muted ? '🔇 Unmute' : '🎤 Mute'}
			</button>
			<button class="btn" class:btn--danger={camOff} onclick={toggleCam}>
				{camOff ? '📷 Camera on' : '🎥 Camera off'}
			</button>
			{#if canFlip}
				<button class="btn" onclick={flipCam} disabled={flipping} title="Switch camera">
					{flipping ? '🔄 Switching…' : '🔄 Flip'}
				</button>
			{/if}
			<button class="btn" onclick={fs.toggle}>
				{fs.isFs ? '✕ Exit' : '⛶ Fullscreen'}
			</button>
			<button class="btn btn--danger" onclick={leaveCall}>✕ Leave call</button>
		</div>
	</div>

	{#if absent.length}
		<div class="vc-invite">
			<span class="muted">📞 Ring to join:</span>
			{#each absent as m (m.uid)}
				<button class="btn btn--sm" disabled={ringing.has(m.uid)} onclick={() => ring(m.uid)}>
					{ringing.has(m.uid) ? '📲 Ringing…' : m.name}
				</button>
			{/each}
		</div>
	{/if}
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
		/* --cols comes from the component: 1 / 2 / 3 by head-count, so tiles grow as
		   the call shrinks */
		grid-template-columns: repeat(var(--cols, 2), 1fr);
		gap: 10px;
	}
	/* a phone in portrait can't hold three across — cap at two, tiles stay legible */
	@media (max-width: 460px) {
		.vc-grid {
			grid-template-columns: repeat(min(var(--cols, 2), 2), 1fr);
		}
	}
	.vc-stage {
		position: relative;
	}
	/* anchor for the floating PiP self tile — must stay unconditional, or the PiP
	   re-anchors to .vc-stage and starts covering the controls again */
	.vc-frame {
		position: relative;
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
	/* stacked grid tiles are wide bands (short + full width) so two or three fill a
	   tall portrait phone as horizontal halves/thirds rather than thin columns */
	.vc-grid > .tile {
		aspect-ratio: 16 / 9;
	}
	/* the self tile is a button (tap to dock/float) — strip the native chrome */
	.tile--self {
		padding: 0;
		border: 2px solid transparent;
		font: inherit;
		color: inherit;
		cursor: pointer;
		width: 100%;
	}
	.tile--self:hover {
		border-color: color-mix(in srgb, var(--accent, #ff4d6d) 60%, transparent);
	}
	/* 3-person: small square self preview, centred below the two stacked halves */
	.tile--below {
		width: clamp(120px, 30%, 180px);
		aspect-ratio: 1 / 1;
		margin: 10px auto 0;
	}
	/* floating picture-in-picture: small, corner, above the grid */
	.tile--pip {
		position: absolute;
		right: 12px;
		bottom: 12px;
		width: clamp(120px, 28%, 200px);
		z-index: 5;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
		border-color: rgba(255, 255, 255, 0.5);
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
	/* ...but only for the front camera. Mirroring the REAR camera is just wrong —
	   you'd be shown a flipped version of the scene in front of you. */
	.tile--me video.rear {
		transform: none;
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
		/* keep Leave/Exit above any absolutely-positioned tile, whatever happens */
		position: relative;
		z-index: 6;
	}
	.vc-invite {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
		justify-content: center;
	}

	/* ---- fullscreen: portaled to <body>, fills the screen, big tiles ---------- */
	.vc-stage--fs {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: #0a0c12;
		display: flex;
		flex-direction: column;
		padding: 14px;
		gap: 12px;
	}
	/* the frame carries the flex chain down to the grid — without this the grid is no
	   longer a flex child and its `flex: 1` below does nothing, collapsing the tiles */
	.vc-stage--fs .vc-frame {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.vc-stage--fs .vc-grid {
		flex: 1;
		min-height: 0;
		/* fill the height too, so the video is as big as the screen allows */
		grid-auto-rows: 1fr;
	}
	/* grid tiles fill the screen — but NOT the floating PiP (it's absolute, so
	   height:100% would stretch it to full height). Scope the fill to grid tiles. */
	.vc-stage--fs .vc-grid > .tile {
		aspect-ratio: auto;
		height: 100%;
	}
	.vc-stage--fs .vc-controls {
		margin-top: 0;
	}
	.vc-stage--fs .tile--pip {
		width: clamp(110px, 15vw, 200px); /* small Google-Meet-style box */
		height: auto;
		aspect-ratio: 4 / 3;
		right: 18px;
		bottom: 12px; /* relative to the frame, so it's clear of the controls by construction */
	}
</style>

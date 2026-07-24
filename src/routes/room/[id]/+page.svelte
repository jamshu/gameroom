<script>
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { user } from '$lib/stores/auth.js';
	import { api } from '$lib/api.js';
	import { createRoomStore } from '$lib/stores/room.js';
	import { gameLabel } from '$lib/games.js';
	import { createVoiceMesh } from '$lib/webrtc.js';
	import RoomLobby from '$lib/components/RoomLobby.svelte';
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import VoiceBar from '$lib/components/VoiceBar.svelte';
	import ThiefFinderTable from '$lib/components/ThiefFinderTable.svelte';
	import ChessBoard from '$lib/components/ChessBoard.svelte';
	import CarromBoard from '$lib/components/CarromBoard.svelte';
	import LudoBoard from '$lib/components/LudoBoard.svelte';
	import Leaderboard from '$lib/components/Leaderboard.svelte';
	import { createHold } from '$lib/holdclock.svelte.js';

	const roomId = $page.params.id;
	const store = createRoomStore(roomId);

	let detail = $state(null); // /api/rooms/[id] response while not yet accepted
	let accepted = $state(false);
	let error = $state('');
	let mesh = null;
	let voicePeers = $state([]); // [{uid, state}] from the mesh
	let inVoice = $state(false);
	let detailTimer = null;

	const myUid = $derived($user?.uid);

	async function loadDetail() {
		try {
			const d = await api(`/api/rooms/${roomId}`);
			detail = d;
			if (d.me?.status === 'accepted') {
				accepted = true;
				clearInterval(detailTimer);
				store.open();
			}
		} catch (e) {
			error = e.message;
		}
	}

	async function requestJoin() {
		try {
			await api(`/api/rooms/${roomId}/join`, { method: 'POST' });
			await loadDetail();
		} catch (e) {
			error = e.message;
		}
	}

	async function joinVoice() {
		try {
			if (!mesh) {
				mesh = createVoiceMesh({
					myUid,
					sendSignal: (toUid, kind, data) =>
						store.post('signal', { toUid, kind, data }).catch(() => {}),
					onPeersChange: (p) => (voicePeers = p)
				});
				store.onSignal((from, payload) => mesh.handleSignal(from, payload));
			}
			// mic permission + TURN credentials FIRST — only then enter the
			// roster, so peers never offer to someone who can't answer yet
			await mesh.join();
			try {
				await store.post('voice', { action: 'join' });
			} catch (e) {
				mesh.leave(); // voice full — release the mic
				throw e;
			}
			inVoice = true;
			mesh.sync($store.voice);
		} catch (e) {
			error = e.message;
			inVoice = false;
		}
	}

	async function leaveVoice() {
		inVoice = false;
		voicePeers = [];
		store.setFast(false);
		mesh?.leave();
		await store.post('voice', { action: 'leave' }).catch(() => {});
	}

	// keep the mesh reconciled with the server's voice roster
	$effect(() => {
		if (inVoice && mesh) mesh.sync($store.voice);
	});

	// 1s polling while any voice pair is still negotiating — signaling rides the
	// poll, so this roughly halves connect time; back to 2s once settled
	$effect(() => {
		const negotiating =
			inVoice &&
			($store.voice.filter((u) => u !== myUid).length > voicePeers.length ||
				voicePeers.some((p) => p.state !== 'connected'));
		store.setFast(negotiating);
	});

	async function leaveRoom() {
		if (!confirm('Leave this room?')) return;
		if (inVoice) await leaveVoice();
		await api(`/api/rooms/${roomId}/leave`, { method: 'POST' }).catch(() => {});
		goto('/');
	}

	onMount(() => {
		loadDetail();
		detailTimer = setInterval(() => {
			if (!accepted) loadDetail();
		}, 5000);
		const bye = () => {
			if (inVoice) navigator.sendBeacon?.(`/api/rooms/${roomId}/voice`, JSON.stringify({ action: 'leave' }));
		};
		window.addEventListener('beforeunload', bye);
		return () => window.removeEventListener('beforeunload', bye);
	});

	onDestroy(() => {
		clearInterval(detailTimer);
		mesh?.leave();
		store.close();
	});

	// The deciding guess flips the room to `finished` immediately, which would
	// swap in the leaderboard before anyone saw (or heard) the final reveal.
	// Keep the table up for the server's hold window first.
	// Deliberately a fixed local duration, NOT the server's remaining-ms. The
	// mid-round hold is a shared deadline because it gates the host's next deal,
	// but nothing coordinates this one — so anchoring it to the guess time would
	// give a player who polled late only the leftover slice of it. Counting from
	// when *this* client received the result gives everyone the full window.
	const FINAL_REVEAL_MS = 5000;
	const finalReveal = createHold(() => {
		const g = $store.game;
		const showing = g?.type === 'thief_finder' && g.phase === 'finished';
		return { key: showing ? `final-${g.draw}` : null, ms: FINAL_REVEAL_MS };
	});

	// The poll gave up because we're no longer in this room (removed, or the room
	// is gone). Tear down voice and get out rather than sitting on a dead board.
	$effect(() => {
		if ($store.closed) {
			mesh?.leave();
			goto(`/?left=${encodeURIComponent($store.error || 'You left this room')}`);
		}
	});

	const room = $derived(accepted ? $store.room : detail?.room);
	const members = $derived(accepted ? $store.members : detail?.members || []);
	const isHost = $derived(room?.hostUid === myUid);
</script>

{#if !room}
	<p class="muted">Loading room…</p>
	{#if error}<p class="error-text">{error}</p>{/if}
{:else}
	<div class="room fade-in">
		<header class="room-head">
			<div>
				<h1 class="room-title">{room.name}</h1>
				<span class="chip chip--accent">{gameLabel(room.gameType)}</span>
				<span class="chip">{room.status}</span>
			</div>
			<button class="btn btn--ghost btn--sm" onclick={leaveRoom}>Leave</button>
		</header>

		{#if error}<p class="error-text">{error}</p>{/if}
		<!-- connection trouble was previously invisible: the board just silently froze -->
		{#if accepted && $store.error}
			<p class="error-text">⚠️ {$store.error} — retrying…</p>
		{/if}

		{#if !accepted}
			<div class="card" style="padding:22px; text-align:center;">
				{#if detail?.me?.status === 'pending'}
					<p>⏳ Waiting for the host to accept your request…</p>
				{:else}
					<p style="margin-bottom:14px;">You're not in this room yet.</p>
					<button class="btn btn--primary" onclick={requestJoin}>Request to join</button>
				{/if}
			</div>
		{:else}
			<div class="room-grid">
				<main class="room-main">
					{#if room.status === 'finished' && !finalReveal.holding}
						<Leaderboard {members} game={$store.game} {store} {isHost} {room} />
					{:else if room.status === 'lobby'}
						<RoomLobby {store} {members} {room} {isHost} />
					{:else if $store.game?.type === 'thief_finder'}
						<ThiefFinderTable {store} game={$store.game} {members} {myUid} {isHost} />
					{:else if $store.game?.type === 'chess'}
						<ChessBoard {store} game={$store.game} {members} {myUid} />
					{:else if $store.game?.type === 'carroms'}
						<CarromBoard {store} game={$store.game} {members} {myUid} />
					{:else if $store.game?.type === 'ludo'}
						<LudoBoard {store} game={$store.game} {members} {myUid} />
					{:else}
						<p class="muted">Loading game…</p>
					{/if}
				</main>
				<aside class="room-side">
					<VoiceBar
						{members}
						voice={$store.voice}
						{voicePeers}
						{inVoice}
						{myUid}
						onjoin={joinVoice}
						onleave={leaveVoice}
						onmute={(m) => mesh?.setMuted(m)}
					/>
					<ChatPanel
					{store}
					{members}
					{myUid}
					{roomId}
					borrowMic={() => mesh?.micStream() ?? null}
				/>
				</aside>
			</div>
		{/if}
	</div>
{/if}

<style>
	.room-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}
	.room-title {
		display: inline;
		font-size: 1.4rem;
		margin-right: 10px;
	}
	.room-grid {
		display: grid;
		grid-template-columns: 1fr 320px;
		gap: 18px;
		align-items: start;
	}
	@media (max-width: 860px) {
		.room-grid {
			grid-template-columns: 1fr;
		}
	}
	.room-side {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
</style>

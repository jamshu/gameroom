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
	let blocked = $state(false); // private room we're not invited to — stop retrying
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
			// Not on a private room's guest list. Retrying every 5s would never
			// succeed and would leave "Loading room…" sitting under the reason.
			if (e.code === 'private') {
				blocked = true;
				clearInterval(detailTimer);
			}
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

	/**
	 * Host cuts a round short and takes everyone back to the lobby, so people can
	 * be re-seated, removed or the game swapped without waiting out a long chess
	 * or ludo match. Lives in the shell rather than in each board: the control is
	 * identical for all four games, and only ThiefFinderTable is passed `isHost`.
	 */
	let ending = $state(false);
	async function endGame() {
		if (!confirm('End this game and go back to the lobby? The current round will be lost.')) return;
		ending = true;
		try {
			await store.post('end', {});
		} catch (e) {
			error = e.message;
		} finally {
			ending = false;
		}
	}

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

	/* What the sidebar holds, and whether it is worth rendering at all.
	   - Chat belongs to the lobby and the wash-up; during play it is a 260–420px
	     slab under the board on a phone, which is the space the game wants.
	   - Thief Finder wants its table clear while it is being PLAYED, so the voice
	     bar comes off screen — but ONLY the bar. Joining happens in the lobby, and
	     anyone already in the call keeps talking straight through the game.

	   That last part is safe rather than lucky: VoiceBar is presentational. The
	   RTCPeerConnection mesh lives here on the page (`mesh`), the component holds
	   nothing but a `muted` flag, and it has no onDestroy — so unmounting it cannot
	   tear down a call. Moving voice state INTO VoiceBar would silently break this.

	   Both flags can be false at once (a Thief Finder game in progress), and an
	   empty <aside> would still draw the grid's 18px gap above the board, so the
	   element itself is conditional. */
	const showChat = $derived(room?.status !== 'playing');
	const showVoice = $derived(
		!(room?.gameType === 'thief_finder' && room?.status === 'playing')
	);

	/* Room-level news that isn't visible anywhere else. A host handover mid-game
	   changes nothing on the board, so without this the new host would only find
	   out by noticing controls they didn't have before.

	   Announcements QUEUE rather than replace each other. One leave can write
	   three system events in a row (round abandoned → host handed on → member
	   left), and a single slot meant the last one silently overwrote the two that
	   actually mattered. Backed-up messages get a shorter dwell so a burst still
	   clears in a few seconds. */
	const NOTICE_MS = 8000;
	const NOTICE_QUEUED_MS = 3500;
	let notice = $state('');
	let noticeTimer = null;
	const pending = [];
	let starting = false;
	function say(text) {
		pending.push(text);
		if (notice || starting) return;
		// Show on the next tick, not this one: a batch of events is handled in a
		// single synchronous ingest, and the dwell depends on how many are waiting.
		// Deciding on the first message would always see an empty queue and give a
		// burst the lone-announcement timing.
		starting = true;
		setTimeout(() => {
			starting = false;
			showNext();
		}, 0);
	}
	function showNext() {
		clearTimeout(noticeTimer);
		notice = pending.shift() || '';
		if (notice) noticeTimer = setTimeout(showNext, pending.length ? NOTICE_QUEUED_MS : NOTICE_MS);
	}
	// A seated player walking out announces itself as `game-abandoned`, which says
	// they left AND what it cost. The generic "left the room" the same request
	// writes right after would only repeat it, so it's suppressed for that player.
	//
	// Matched on a short time window rather than a remembered uid: the two events
	// can arrive in separate polls, and a marker that only cleared when its pair
	// showed up would sit there for the rest of the session and silently eat that
	// player's NEXT departure. A window expires on its own.
	const ABANDON_WINDOW_MS = 15_000;
	let abandoned = { uid: null, at: 0 };
	store.onSystem((ev) => {
		const who = (uid) =>
			Number(uid) === myUid ? 'You' : members.find((m) => m.uid === Number(uid))?.name || 'Someone';
		const kind = ev.payload?.kind;
		if (kind === 'host-changed') {
			const name = who(ev.payload.uid);
			say(`👑 ${name} ${name === 'You' ? 'are' : 'is'} now the host.`);
			// The Ably push carries EVENTS only — `room` (and so `hostUid`) rides the
			// poll. Without this nudge a push-connected client would show the banner
			// now but not grow the host controls until the safety poll, 8s later.
			store.pollNow();
		} else if (kind === 'game-abandoned') {
			abandoned = { uid: Number(ev.payload.uid), at: Date.now() };
			say(`${who(ev.payload.uid)} left mid-game — the round was dropped, back to the lobby.`);
		} else if (kind === 'member-left') {
			const uid = Number(ev.payload.uid);
			// already announced, with the reason attached
			if (uid === abandoned.uid && Date.now() - abandoned.at < ABANDON_WINDOW_MS) return;
			const name = who(uid);
			say(`👋 ${name} ${name === 'You' ? 'have' : 'has'} left the room.`);
		} else if (kind === 'member-removed') {
			const name = who(ev.payload.uid);
			say(`👋 ${name} ${name === 'You' ? 'were' : 'was'} removed from the room.`);
		} else if (kind === 'game-ended') {
			// the board vanishing is the only other signal, and it looks identical to
			// a game that simply finished — say who did it and that it was cut short
			const name = who(ev.senderUid);
			say(`🛑 ${name} ended the game — back to the lobby.`);
		} else if (kind === 'role-changed') {
			// the player who lost their seat is the one who has to be told: the role
			// chip flips in a list they may not be looking at, and they'd otherwise
			// find out by tapping a board that no longer responds
			const seat = (uid, role) => {
				const name = who(uid);
				say(`↕️ ${name} ${name === 'You' ? 'are' : 'is'} now a ${role}.`);
			};
			seat(ev.payload.uid, ev.payload.role);
			if (ev.payload.demotedUid) seat(ev.payload.demotedUid, 'spectator');
		}
	});
	onDestroy(() => clearTimeout(noticeTimer));
</script>

{#if blocked}
	<div class="card" style="padding:22px; text-align:center;">
		<p style="margin-bottom:14px;">🔒 {error}</p>
		<a class="btn btn--primary" href="/">Back to rooms</a>
	</div>
{:else if !room}
	<p class="muted">Loading room…</p>
	{#if error}<p class="error-text">{error}</p>{/if}
{:else}
	<div class="room fade-in">
		<header class="room-head">
			<div>
				<h1 class="room-title">{room.name}</h1>
				<span class="chip chip--accent">{gameLabel(room.gameType)}</span>
				{#if room.visibility === 'private'}<span class="chip" title="Invite only">🔒 private</span>{/if}
				<span class="chip">{room.status}</span>
			</div>
			<div class="head-actions">
				{#if isHost && room.status === 'playing'}
					<button class="btn btn--ghost btn--sm" onclick={endGame} disabled={ending}>
						{ending ? 'Ending…' : 'End game'}
					</button>
				{/if}
				<button class="btn btn--ghost btn--sm" onclick={leaveRoom}>Leave</button>
			</div>
		</header>

		{#if error}<p class="error-text">{error}</p>{/if}
		<!-- connection trouble was previously invisible: the board just silently froze -->
		{#if accepted && $store.error}
			<p class="error-text">⚠️ {$store.error} — retrying…</p>
		{/if}
		{#if notice}<p class="chip chip--amber room-notice">{notice}</p>{/if}

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
			<div class="room-grid" class:room-grid--playing={room.status === 'playing'}>
				<main class="room-main">
					{#if room.status === 'finished' && !finalReveal.holding}
						<Leaderboard {members} game={$store.game} {store} {isHost} {myUid} {room} />
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
				<!-- see showChat / showVoice above for why each is here or not.
				     Unmounting chat rather than hiding it is safe: the history lives in
				     the store ($store.chat) and in-flight uploads are detached closures
				     that still resolve into it, so nothing here is load-bearing. -->
				{#if showVoice || showChat}
					<aside class="room-side">
						{#if showVoice}
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
						{/if}
						{#if showChat}
							<ChatPanel
								{store}
								{members}
								{myUid}
								{roomId}
								borrowMic={() => mesh?.micStream() ?? null}
							/>
						{/if}
					</aside>
				{/if}
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
	.head-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}
	.room-notice {
		display: inline-block;
		margin-bottom: 12px;
	}
	.room-title {
		display: inline;
		font-size: 1.4rem;
		margin-right: 10px;
	}
	.room-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 320px);
		gap: 18px;
		align-items: start;
	}
	/* Chat is gone during play, so give the board the room.

	   BOTH halves of this are needed. The app shell is capped at --maxw: 760px
	   (app.css), so the two-column grid leaves the board a ~390px column — the
	   board's own 520px cap never even binds on desktop. Collapsing to one column
	   is what actually frees the width; raising the cap is what lets the board use
	   it. Either alone is a no-op. The voice bar keeps its place in the sidebar and
	   simply flows under the board, which is already the mobile layout.

	   The clamp floor is load-bearing, not tidiness: bare `calc(100svh - 240px)`
	   resolves to 480px at a 1280x720 viewport, which would make the board SMALLER
	   than the 520px it is today. Floor at today's cap so this can only ever grow
	   the board; ceiling at 720px so a tall monitor gets a board, not a wall.
	   240px is the page header + room header + the board's own status chrome. */
	.room-grid--playing {
		grid-template-columns: minmax(0, 1fr);
		--board-cap: clamp(520px, calc(100svh - 240px), 720px);
	}
	/* Track the board rather than the full column, and centre. Without this a
	   floored 520px board sits inside a 728px card with ~190px of dead card to its
	   right, which reads as broken. +42px is the game card's 20px padding either
	   side plus its border, so the board still reaches --board-cap exactly. */
	.room-grid--playing .room-main,
	.room-grid--playing .room-side {
		max-width: calc(var(--board-cap) + 42px);
		margin-inline: auto;
		width: 100%;
	}
	/* Collapsing the grid drops the sidebar BELOW the board, which on a 720px-tall
	   screen puts the mute button ~300px past the fold — voice is meant to stay to
	   hand during a game, so lift it above the board. It is a single compact row.
	   Desktop only: on mobile the board is already first and pushing it down is
	   the opposite of what hiding chat was for. */
	@media (min-width: 761px) {
		.room-grid--playing .room-side {
			order: -1;
		}
	}
	@media (max-width: 760px) {
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

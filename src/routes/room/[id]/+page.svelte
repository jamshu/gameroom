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
	import SudokuRace from '$lib/components/SudokuRace.svelte';
	import Match3Race from '$lib/components/Match3Race.svelte';
	import BlackjackBoard from '$lib/components/BlackjackBoard.svelte';
	import VideoCallRoom from '$lib/components/VideoCallRoom.svelte';
	import Leaderboard from '$lib/components/Leaderboard.svelte';
	import Scoreboard from '$lib/components/Scoreboard.svelte';
	import { createHold } from '$lib/holdclock.svelte.js';
	import { arm, playWave } from '$lib/sound.js';
	import { chessOutcomeText } from '$lib/shared/gamelogic.js';

	const roomId = $page.params.id;
	const store = createRoomStore(roomId);

	let detail = $state(null); // /api/rooms/[id] response while not yet accepted
	let accepted = $state(false);
	let error = $state('');
	let blocked = $state(false); // private room we're not invited to — stop retrying
	let mesh = null;
	let dropSignal = null; // releases the shared signal channel — see joinVoice
	let voicePeers = $state([]); // [{uid, state}] from the mesh
	let inVoice = $state(false);
	let joining = $state(false); // a join is mid-flight (mic perm + roster POST)
	let autoJoined = false; // one-shot: auto-join when arriving from a call push
	let detailTimer = null;

	const myUid = $derived($user?.uid);
	// Paid tier (x_studio_is_premium on res.users, cached in the identity cookie).
	// Unlocks the chess engine hint. The engine runs in the browser, so there is no
	// server round trip to guard — this gate is presentational, not enforcement.
	const isPremium = $derived(!!$user?.premium);

	async function loadDetail() {
		try {
			const d = await api(`/api/rooms/${roomId}`);
			detail = d;
			if (d.me?.status === 'accepted') {
				accepted = true;
				clearInterval(detailTimer);
				// `d.do` decides the transport. Resolved here, after the detail fetch
				// and before the only store.open() call, so there is exactly one place
				// that knows and no window where the store guesses.
				store.open({ useSocket: d.do === true });
			} else if ($page.url.searchParams.get('call') && !autoJoined) {
				// Arrived from a call push (?call=1): walk straight in instead of
				// showing a Join button. Private/call rooms auto-accept the callee, so
				// the join lands them accepted and loadDetail re-runs into the branch
				// above. Guarded so a public room that only makes them pending doesn't loop.
				autoJoined = true;
				await requestJoin();
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

	// Screen Wake Lock: keep the display on during a call so the phone's auto-lock
	// never fires — a lock suspends the page, which drops the mic + peer mesh.
	// Best-effort: unsupported browsers (older iOS) just no-op. The OS releases the
	// sentinel whenever the page is hidden, so it is re-acquired on visibility.
	let wakeLock = null;
	async function acquireWake() {
		if (wakeLock || !inVoice) return;
		try {
			wakeLock = await navigator.wakeLock?.request('screen');
			wakeLock?.addEventListener?.('release', () => (wakeLock = null));
		} catch {
			wakeLock = null;
		}
	}
	function releaseWake() {
		try {
			wakeLock?.release?.();
		} catch {}
		wakeLock = null;
	}

	/**
	 * `heal` means "we never left — put us back". Recovery paths pass it so the
	 * room is not told we joined: the object drops a uid the moment its last socket
	 * closes and appends nothing, so announcing the way back in would leave an
	 * unpaired "joined voice" in the log for every iOS app switch. Only the button
	 * is a real join.
	 */
	async function joinVoice(heal = false) {
		joining = true;
		try {
			if (!mesh) {
				mesh = createVoiceMesh({
					myUid,
					// A 403 here is /signal's "Join voice first" — the roster telling us
					// we are not in it, and the fastest notice we get of a drop. It used
					// to be swallowed with everything else, which is how a dropped peer
					// went unnoticed. Pull a fresh state so the heal effect above sees
					// the real roster now rather than at the next push.
					sendSignal: (toUid, kind, data) =>
						store.post('signal', { toUid, kind, data }).catch((e) => {
							if (e?.status === 403) store.pollNow?.();
						}),
					onPeersChange: (p) => (voicePeers = p)
				});
			}
			/* OUTSIDE the `if (!mesh)` above, and that placement is the fix rather than
			   tidiness. `mesh` is created once and never nulled, so a second join
			   skipped this line entirely — and if a video call had come and gone in
			   between, the shared signal channel was still pointing at ITS mesh (or,
			   once that component learned to release it, at nobody). Either way every
			   offer and answer went nowhere and the bar sat on "connecting…" forever.
			   Re-claiming on every join costs one assignment and closes both cases. */
			dropSignal?.();
			dropSignal = store.onSignal((from, payload) => mesh.handleSignal(from, payload));
			// mic permission + TURN credentials FIRST — only then enter the
			// roster, so peers never offer to someone who can't answer yet
			await mesh.join();
			try {
				await store.post('voice', { action: 'join', heal });
			} catch (e) {
				mesh.leave(); // voice full — release the mic
				throw e;
			}
			inVoice = true;
			mesh.sync($store.voice);
			acquireWake();
		} catch (e) {
			error = e.message;
			inVoice = false;
		} finally {
			joining = false;
		}
	}

	async function leaveVoice() {
		inVoice = false;
		voicePeers = [];
		releaseWake();
		// Hand the channel back rather than leaving a left mesh holding it — the same
		// reasoning as VideoCallRoom's onDestroy. joinVoice re-claims it.
		dropSignal?.();
		dropSignal = null;
		mesh?.leave();
		await store.post('voice', { action: 'leave' }).catch(() => {});
	}

	// keep the mesh reconciled with the server's voice roster
	$effect(() => {
		if (inVoice && mesh) mesh.sync($store.voice);
	});

	/* Self-heal the OTHER direction: the server dropped us while we still think we
	   are in the call.

	   Two things do that, and neither used to be recoverable. The object drops a
	   uid from voice whenever its last socket closes — the right call for a closed
	   tab, but a backgrounded phone or a carrier-NAT blip looks identical. And an
	   unrelated write used to clobber the roster wholesale (fixed server-side, but
	   this is what made it terminal rather than a blip).

	   Nothing re-added us. `sync()` filters myUid out of the roster and never asks
	   whether IT is listed, so the peers stay half-built; every re-offer POSTs
	   /signal and takes a 403 "Join voice first" that was thrown away; the bar sits
	   on "Connecting voice…" until the player thinks to press Leave and Join.

	   So re-enter the roster, flagged `heal` so the room is not told we "joined" —
	   nothing told it we left, and on iOS that drop happens on every app switch.

	   HEAL_TRIES bounds the case where the server keeps REFUSING (voice full, a
	   room we are no longer in): rather than retry forever we give the mic back and
	   let the button say Join voice again, which is at least honest. It deliberately
	   does not bound successful heals — those reset the budget, because one re-entry
	   per genuine disconnect is exactly the right number. */
	const HEAL_TRIES = 3;
	let healing = false;
	let healTries = 0;
	$effect(() => {
		if (!inVoice || joining || healing || myUid == null) return;
		if ($store.voice.includes(myUid)) {
			healTries = 0; // back in and talking — a later, unrelated drop gets its own budget
			return;
		}
		if (healTries >= HEAL_TRIES) return;
		healTries++;
		healing = true;
		(async () => {
			try {
				// A drop we slept through usually took the capture with it (iOS ends the
				// track on screen-lock). Same treatment the visibility handler gives it:
				// rebuild the whole mesh rather than re-entering a roster with a dead mic.
				if (mesh && !mesh.micLive()) {
					mesh.leave();
					await joinVoice(true);
					return;
				}
				await store.post('voice', { action: 'join', heal: true });
				mesh?.sync($store.voice);
			} catch (e) {
				error = e.message;
				await leaveVoice();
			} finally {
				healing = false;
			}
		})();
	});

	// Self-heal a stale roster entry. Leaving via browser/home nav can lose the
	// best-effort beforeunload beacon, so on returning we mount fresh (inVoice
	// false) while the server still lists us in the call. Post one leave to drop
	// the ghost — it bumps the state version and pushes the cleaned roster to
	// everyone, so our name disappears for the whole room. Once per mount.
	let voiceSelfHealed = false;
	$effect(() => {
		if (voiceSelfHealed || !accepted || inVoice || joining || myUid == null) return;
		// the video-call room legitimately puts us in the voice roster while this
		// shell's own inVoice stays false — don't mistake that for a stale ghost
		if ($store.game?.type === 'videocall') return;
		if ($store.voice.includes(myUid)) {
			voiceSelfHealed = true;
			store.post('voice', { action: 'leave' }).catch(() => {});
		}
	});

	// The "poll faster while voice is negotiating" effect that used to live here is
	// gone with the tier ladder. Signaling no longer rides the poll at all — a
	// `signal` event is a targeted frame on the room's socket, delivered in
	// milliseconds — and on the fallback path FALLBACK_MS is already 2s, which is
	// what the fast tier was reaching for anyway.

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

	/**
	 * Back to the dashboard, still a member.
	 *
	 * This is what almost everyone pressing the old "Leave" actually wanted — they
	 * meant "close this screen", not "give up my seat", and for a private room the
	 * latter costs them a fresh invite to undo. So Quit takes that slot and Leave
	 * moves into the ⋮ menu.
	 *
	 * No confirm: nothing is lost, and walking back in undoes it.
	 *
	 * leaveVoice() is NOT cosmetic. The beforeunload beacon does not fire on an SPA
	 * navigation, and onDestroy's mesh.leave() only tears the peers down locally —
	 * it never tells the server. Without this you stay listed in the voice roster
	 * for everyone else until the stale-ghost effect happens to catch it later.
	 */
	async function quitRoom() {
		if (inVoice) await leaveVoice();
		goto('/');
	}

	async function leaveRoom() {
		if (!confirm('Leave this room?')) return;
		if (inVoice) await leaveVoice();
		await api(`/api/rooms/${roomId}/leave`, { method: 'POST' }).catch(() => {});
		goto('/');
	}

	/* Inline rename, host only. Kept in the header next to the title rather than
	   behind a settings panel — there is no settings panel, and the thing being
	   edited is right there. */
	let renaming = $state(false);
	let renameText = $state('');
	let savingName = $state(false);
	function startRename() {
		renameText = room?.name ?? '';
		renaming = true;
	}
	async function saveName() {
		const clean = renameText.trim();
		if (!clean || clean === room?.name) {
			renaming = false;
			return;
		}
		savingName = true;
		try {
			await store.post('name', { name: clean });
			renaming = false;
		} catch (e) {
			error = e.message;
		} finally {
			savingName = false;
		}
	}

	/* ⋮ menu plumbing, copied from RoomLobby rather than shared. The listener has to
	   live HERE too: RoomLobby's identical effect is unmounted for the whole time a
	   game is running, so without this copy the header kebab would stop closing on
	   outside-click exactly when the room is in play. Both sweep every open kebab,
	   so having the two mounted together is harmless. */
	$effect(() => {
		function onDown(e) {
			for (const d of document.querySelectorAll('details.kebab[open]')) {
				if (!d.contains(e.target)) d.open = false;
			}
		}
		document.addEventListener('pointerdown', onDown);
		return () => document.removeEventListener('pointerdown', onDown);
	});
	const closeMenu = (e) => e.currentTarget.closest('details')?.removeAttribute('open');

	let deleting = $state(false);
	async function deleteRoom() {
		if (!confirm('Delete this room for everyone? This cannot be undone.')) return;
		deleting = true;
		try {
			if (inVoice) await leaveVoice();
			await api(`/api/rooms/${roomId}`, { method: 'DELETE' });
			goto('/');
		} catch (e) {
			error = e.message;
			deleting = false;
		}
	}

	onMount(() => {
		// Arm the audio unlock from the ROOM, not just the boards. A wave lands in
		// the lobby, where none of the board components are mounted — without this
		// the first gesture to unlock the AudioContext might never be listened for
		// and the wave chime would be silent for anyone who hadn't started a game.
		arm();
		loadDetail();
		detailTimer = setInterval(() => {
			if (!accepted) loadDetail();
		}, 5000);
		const bye = () => {
			if (inVoice) navigator.sendBeacon?.(`/api/rooms/${roomId}/voice`, JSON.stringify({ action: 'leave' }));
		};
		window.addEventListener('beforeunload', bye);

		// Coming back from a lock/background: the wake-lock sentinel was released and
		// the mesh may have stalled while the page was suspended. Re-acquire the lock,
		// pull a fresh roster and re-sync so any dropped peer is rebuilt.
		const onVisible = async () => {
			if (document.visibilityState !== 'visible' || !inVoice || joining) return;
			acquireWake();
			// Auto-rejoin: if the OS ended the mic while suspended (typical on iOS
			// screen-lock), the peers carry dead audio. Tear the mesh down and rejoin
			// to re-open the mic + rebuild the connections — no manual tap needed.
			if (mesh && !mesh.micLive()) {
				mesh.leave();
				await joinVoice(true); // coming back from a lock is not a new join
				return;
			}
			store.pollNow?.();
			mesh?.sync($store.voice);
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			window.removeEventListener('beforeunload', bye);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	onDestroy(() => {
		clearInterval(detailTimer);
		releaseWake();
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
	// The board games swap to the leaderboard the instant a winner is set, so the
	// winning move (checkmate, last token home, the winning shot) is never seen —
	// the board unmounts before its move-animation effect can play. Holding keeps
	// the board mounted long enough to animate the final move first. Per-game
	// because a carrom shot replays for up to ~2s while a chess slide is 210ms.
	const REPLAY_MS = { chess: 1400, ludo: 1400, carroms: 2600 };
	const finalReveal = createHold(() => {
		const g = $store.game;
		if (!g) return { key: null };
		if (g.type === 'thief_finder') {
			const showing = g.phase === 'finished';
			return { key: showing ? `final-${g.draw}` : null, ms: FINAL_REVEAL_MS };
		}
		// The race games end on a completed grid or an expired clock, never on a
		// move worth watching — the last thing that happened is already on screen.
		// Holding here would just be dead time in front of the leaderboard.
		if (g.type === 'sudoku' || g.type === 'match3') return { key: null };
		// Skip the endings that applied NO MOVE — resign, agreed draw, and a flag on
		// time. There is nothing for the board to animate, so the hold would be a
		// blank 1.4s delay in front of the leaderboard. Checkmate and stalemate are
		// deliberately NOT in this list: those do land a final move worth seeing.
		//
		// A constant key is fine: `result` is null between games, so the hold resets
		// through null on a rematch and re-fires on the next win.
		const NO_REPLAY = new Set(['resign', 'draw-agreed', 'timeout']);
		const replay = g.result && !NO_REPLAY.has(g.endReason);
		return { key: replay ? 'win' : null, ms: REPLAY_MS[g.type] || 1600 };
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
		!(room?.gameType === 'thief_finder' && room?.status === 'playing') &&
			// the video-call room runs its OWN media mesh on the same signal channel;
			// a second voice mesh here would fight it for the single signal handler
			$store.game?.type !== 'videocall'
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
		} else if (kind === 'room-renamed') {
			say(`✏️ ${who(ev.senderUid)} renamed the room to “${ev.payload.name}”.`);
		} else if (kind === 'wave') {
			// only worth saying when someone else waved — the sender knows they did
			if (Number(ev.payload.uid) !== myUid) {
				say(`👋 ${who(ev.payload.uid)} waved!`);
				// Silent if nothing has been tapped since load — the AudioContext is
				// still suspended and no amount of arming fixes that, it's the autoplay
				// policy. The push notification is the fallback for that case.
				playWave();
			}
		} else if (kind === 'lobby-reset') {
			// Nobody pressed anything — the idle-reset cron cleared the finished round.
			// Without this the leaderboard just vanishes and the lobby appears, which
			// reads as the app losing the result rather than moving on from it.
			say('🔄 The last round was cleared — back to the lobby.');
		} else if (kind === 'game-over') {
			// Gated on endReason, which ONLY chess sets. The other games publish this
			// same kind with an incompatible payload — carroms sends a team id in
			// `result`, ludo a uid in `winner`, thief nothing at all — and reading a
			// carrom team as a chess colour would announce the wrong winner. They
			// also each end on a board everyone is already watching, so they lose
			// nothing by staying silent here.
			const { result, endReason, winnerUid } = ev.payload || {};
			if (endReason) {
				const isYou = Number(winnerUid) === myUid;
				say(`♟️ ${chessOutcomeText(result, endReason, who(winnerUid), isYou)}.`);
			}
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
				{#if renaming}
					<form class="rename-row" onsubmit={(e) => { e.preventDefault(); saveName(); }}>
						<!-- svelte-ignore a11y_autofocus -->
						<input
							class="input rename-input"
							bind:value={renameText}
							maxlength="60"
							autofocus
							aria-label="Room name"
							onkeydown={(e) => e.key === 'Escape' && (renaming = false)}
						/>
						<button class="btn btn--primary btn--sm" type="submit" disabled={savingName}>
							{savingName ? 'Saving…' : 'Save'}
						</button>
						<button class="btn btn--ghost btn--sm" type="button" onclick={() => (renaming = false)}>
							Cancel
						</button>
					</form>
				{:else}
					<h1 class="room-title">
						{room.name}
						{#if isHost}
							<button class="rename-btn" onclick={startRename} title="Rename room" aria-label="Rename room">✏️</button>
						{/if}
					</h1>
				{/if}
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
				<!-- The two irreversible actions live behind the ⋮ so neither can be hit
				     by someone reaching for the way out. Labels say "room" because next
				     to Quit the bare verbs no longer tell you what they act on. -->
				<details class="kebab">
					<summary class="btn btn--ghost btn--sm" title="Room actions" aria-label="Room actions">⋮</summary>
					<div class="kebab-panel">
						<button
							class="btn btn--ghost btn--sm"
							onclick={(e) => {
								closeMenu(e);
								leaveRoom();
							}}>Leave room</button
						>
						{#if isHost}
							<button
								class="btn btn--ghost btn--sm btn--danger"
								disabled={deleting}
								onclick={(e) => {
									closeMenu(e);
									deleteRoom();
								}}>{deleting ? 'Deleting…' : '🗑 Delete room'}</button
							>
						{/if}
					</div>
				</details>
				<button class="btn btn--ghost btn--sm" onclick={quitRoom}>Quit</button>
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
			<!-- Outside the status if/else below on purpose: the tally has to survive
			     lobby → playing → finished, and anything inside that chain is
			     unmounted the moment the room changes status.
			     Hidden WHILE PLAYING, though, and that is about vertical space, not
			     taste: --board-cap below has a hard 520px floor, so the board cannot
			     give any height back — a bar above the grid just pushes the board down
			     and makes a 720px-tall screen scroll mid-game. The standings matter in
			     the lobby and on the results screen, which is where they still are. -->
			{#if room.status !== 'playing'}
				<Scoreboard {members} wins={$store.wins} />
			{/if}
			<div class="room-grid" class:room-grid--playing={room.status === 'playing'}>
				<main class="room-main">
					{#if room.status === 'finished' && !finalReveal.holding}
						<Leaderboard {members} game={$store.game} {store} {isHost} {myUid} {room} />
					{:else if room.status === 'lobby'}
						<RoomLobby {store} {members} {room} {isHost} />
					{:else if $store.game?.type === 'thief_finder'}
						<ThiefFinderTable {store} game={$store.game} {members} {myUid} {isHost} />
					{:else if $store.game?.type === 'chess'}
						<ChessBoard {store} game={$store.game} {members} {myUid} {isPremium} />
					{:else if $store.game?.type === 'carroms'}
						<CarromBoard {store} game={$store.game} {members} {myUid} />
					{:else if $store.game?.type === 'ludo'}
						<LudoBoard {store} game={$store.game} {members} {myUid} />
					{:else if $store.game?.type === 'videocall'}
						<VideoCallRoom {store} game={$store.game} {members} {myUid} />
					{:else if $store.game?.type === 'sudoku'}
						<SudokuRace {store} game={$store.game} {members} {myUid} />
					{:else if $store.game?.type === 'match3'}
						<Match3Race {store} game={$store.game} {members} {myUid} />
					{:else if $store.game?.type === 'blackjack'}
						<BlackjackBoard {store} game={$store.game} {members} {myUid} />
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
								voiceMs={$store.voiceMs}
								voiceAt={$store.voiceAt}
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
	/* Duplicated from RoomLobby, not imported: Svelte scopes styles per component,
	   so there is no way to share these without lifting the whole menu into one. */
	.kebab {
		position: relative;
	}
	.kebab > summary {
		list-style: none;
		cursor: pointer;
		line-height: 1;
	}
	.kebab > summary::-webkit-details-marker {
		display: none;
	}
	.kebab-panel {
		position: absolute;
		right: 0;
		top: 100%;
		z-index: 10;
		margin-top: 4px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px;
		min-width: 150px;
		max-width: min(220px, calc(100vw - 24px));
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: var(--shadow-sm);
	}
	.kebab-panel .btn {
		justify-content: flex-start;
		width: 100%;
	}
	.room-notice {
		display: inline-block;
		margin-bottom: 12px;
	}
	/* ✏️ rides inside the <h1> so it sits on the title's baseline however the
	   name wraps — a sibling would drift on a two-line title */
	.rename-btn {
		border: 0;
		background: none;
		padding: 0 0 0 6px;
		font-size: 0.7em;
		line-height: 1;
		cursor: pointer;
		opacity: 0.55;
	}
	.rename-btn:hover {
		opacity: 1;
	}
	.rename-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 6px;
	}
	.rename-input {
		width: min(320px, 60vw);
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

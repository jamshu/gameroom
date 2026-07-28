<script>
	import Avatar from './Avatar.svelte';

	let { members, voice, voiceMs, voiceAt, voicePeers, inVoice, myUid, onjoin, onleave, onmute } =
		$props();
	let muted = $state(false);
	let busy = $state(false);

	/* Call timer. The server sends elapsed-ms measured at ITS clock (voiceMs) plus
	   the moment that snapshot landed here (voiceAt), so we extrapolate from the
	   pair instead of differencing an absolute stamp against Date.now() — the same
	   reason the chess clock sends remaining-ms rather than a deadline.

	   `now` is a ticking $state rather than a derived value because nothing else
	   changes between polls: without its own heartbeat the readout would freeze
	   and only jump when some unrelated state landed. */
	let now = $state(Date.now());
	let tick;
	$effect(() => {
		if (voiceMs == null) return; // no call — don't burn a timer
		tick = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(tick);
	});

	const elapsed = $derived(voiceMs == null ? null : voiceMs + Math.max(0, now - (voiceAt ?? now)));

	/** h:mm:ss once past an hour, m:ss before — a call is counting up, not down. */
	function formatCall(ms) {
		const t = Math.max(0, Math.floor(ms / 1000));
		const s = String(t % 60).padStart(2, '0');
		const m = Math.floor(t / 60) % 60;
		const h = Math.floor(t / 3600);
		return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
	}

	const inVoiceMembers = $derived(members.filter((m) => voice.includes(m.uid)));
	// still negotiating if a roster peer has no pc yet, or its pc isn't connected
	const connecting = $derived(
		inVoice &&
			(voice.filter((u) => u !== myUid).length > voicePeers.length ||
				voicePeers.some((p) => p.state !== 'connected'))
	);

	async function toggle() {
		busy = true;
		try {
			if (inVoice) await onleave();
			else await onjoin();
		} finally {
			busy = false;
		}
	}

	function toggleMute() {
		muted = !muted;
		onmute(muted);
	}
</script>

<div class="card" style="padding:14px;">
	<div class="voice-head">
		<span class="label" style="margin:0;">🎙️ Voice ({voice.length}/8)</span>
		<div style="display:flex; gap:6px;">
			{#if inVoice}
				<button class="btn btn--sm btn--ghost" onclick={toggleMute}>{muted ? '🔇 Unmute' : '🎤 Mute'}</button>
			{/if}
			<button class="btn btn--sm {inVoice ? 'btn--danger' : 'btn--primary'}" onclick={toggle} disabled={busy}>
				{busy ? '…' : inVoice ? 'Leave' : 'Join voice'}
			</button>
		</div>
	</div>
	{#if connecting}
		<p class="muted" style="margin:6px 0 0; font-size:0.8rem;">Connecting voice…</p>
	{:else if elapsed != null}
		<!-- only once two people are actually in: one person sitting in voice is
		     waiting, not on a call -->
		<p class="call-time" aria-label="Call duration">
			<span class="call-dot"></span>{formatCall(elapsed)}
		</p>
	{/if}
	{#if inVoiceMembers.length}
		<div class="voice-people">
			{#each inVoiceMembers as m (m.uid)}
				<span class="voice-person" title={m.name}>
					<Avatar uid={m.uid} name={m.name} size={26} />
					<span class="voice-name">{m.uid === myUid ? 'you' : m.name}</span>
				</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.voice-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.call-time {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 6px 0 0;
		font-size: 0.8rem;
		color: var(--text-dim);
		/* digits must not reflow the row every second */
		font-variant-numeric: tabular-nums;
	}
	.call-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--green, #2ecc71);
		box-shadow: 0 0 6px -1px var(--green, #2ecc71);
	}
	@media (prefers-reduced-motion: no-preference) {
		.call-dot {
			animation: call-pulse 2s ease-in-out infinite;
		}
	}
	@keyframes call-pulse {
		50% {
			opacity: 0.35;
		}
	}
	.voice-people {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}
	.voice-person {
		display: flex;
		align-items: center;
		gap: 5px;
		max-width: 160px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 2px 10px 2px 2px;
		font-size: 0.8rem;
	}
	.voice-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

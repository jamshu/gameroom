<script>
	import Avatar from './Avatar.svelte';

	let { members, voice, voicePeers, inVoice, myUid, onjoin, onleave, onmute } = $props();
	let muted = $state(false);
	let busy = $state(false);

	const inVoiceMembers = $derived(members.filter((m) => voice.includes(m.uid)));
	const connectedCount = $derived(voicePeers.length);

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
	{#if inVoice && connectedCount < inVoiceMembers.length - 1}
		<p class="muted" style="margin:6px 0 0; font-size:0.8rem;">Connecting voice…</p>
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
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 2px 10px 2px 2px;
		font-size: 0.8rem;
	}
</style>

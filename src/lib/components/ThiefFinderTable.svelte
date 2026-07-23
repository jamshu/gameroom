<script>
	import { onMount, onDestroy } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { playCorrect, playWrong, isMuted, setMuted, arm } from '$lib/sound.js';
	import { createHold } from '$lib/holdclock.svelte.js';

	let { store, game, members, myUid, isHost } = $props();
	let error = $state('');
	let busy = $state(false);
	let muted = $state(false);

	const nameOf = $derived((uid) => members.find((m) => m.uid === Number(uid))?.name || `#${uid}`);
	const isPolice = $derived(game.policeUid === myUid);
	const amPlayer = $derived(game.players.includes(myUid));

	const ROLE_EMOJI = {
		King: '👑', Queen: '👸', Minister: '🎩', Soldier: '⚔️', Sepoy: '🪖',
		Guard: '🛡️', Farmer: '🌾', Trader: '⚖️', Barber: '✂️', Cobbler: '🥾',
		Police: '👮', Thief: '🥷'
	};
	const MEDAL = ['🥇', '🥈', '🥉'];

	onMount(() => {
		muted = isMuted();
		arm(); // catch a gesture now, so the first reveal isn't silently blocked
	});

	function toggleMute() {
		muted = !muted;
		setMuted(muted);
	}

	async function act(path, body) {
		error = '';
		busy = true;
		try {
			await store.post(path, body || {});
		} catch (e) {
			error = e.message;
		} finally {
			busy = false;
		}
	}

	/* -- reveal hold + auto draw ---------------------------------------------
	   The reveal sits for a few seconds so everyone's poll lands inside it, then
	   the next draw fires on its own. Only the host may deal (the endpoint is
	   host-only), so the host's client is what drives the timer — everyone else
	   just watches the countdown. The server enforces the window regardless. */
	const hold = createHold(() => ({
		key: game.phase === 'reveal' ? `draw-${game.draw}` : null,
		ms: game.revealHoldMs
	}));
	const secondsLeft = $derived(hold.secondsLeft);

	// The deal is fired by a plain timer rather than by watching the countdown
	// reach zero: an effect that both triggers the deal and reads the ticking
	// clock is easy to get wrong, and `act()` writes state, which must never
	// happen synchronously inside an effect. Plain lets, so nothing here feeds
	// back into the effect that sets it up.
	let dealTimer = null;
	let armedDraw = null;

	$effect(() => {
		const phase = game.phase;
		const draw = game.draw;
		const ms = game.revealHoldMs || 0;
		if (!isHost || phase !== 'reveal') {
			armedDraw = null;
			return;
		}
		if (armedDraw === draw) return; // already armed for this round
		armedDraw = draw;
		clearTimeout(dealTimer);
		// +400ms of slack so the server's own hold guard has certainly elapsed
		dealTimer = setTimeout(async () => {
			await act('thief/deal');
			if (error) {
				armedDraw = null; // one retry, then the manual button takes over
				dealTimer = setTimeout(() => act('thief/deal'), 2000);
			}
		}, ms + 400);
	});

	onDestroy(() => clearTimeout(dealTimer));

	/* -- reveal sound --------------------------------------------------------
	   Driven by state, not by the guess click: the result reaches everyone
	   through the poll. Plain `let` (not $state) so the effect doesn't depend on
	   what it writes. The first run only records, so a refresh mid-reveal — or
	   arriving late — doesn't fire a stale sound. */
	let soundedDraw = null;
	let soundReady = false;

	$effect(() => {
		const r = game.phase === 'reveal' || game.phase === 'finished' ? game.lastResult : null;
		if (r && r.draw !== soundedDraw) {
			soundedDraw = r.draw;
			if (soundReady) (r.correct ? playCorrect : playWrong)();
		}
		soundReady = true;
	});

	const sortedTotals = $derived(Object.entries(game.totals || {}).sort((a, b) => b[1] - a[1]));

	const result = $derived(game.lastResult);
	function revealClass(uid) {
		if (!result) return '';
		const u = Number(uid);
		if (u === result.thiefUid) return result.correct ? 'row--caught' : 'row--escaped';
		if (u === result.accusedUid) return 'row--accused';
		return '';
	}
	function revealRing(uid) {
		if (!result) return 'none';
		const u = Number(uid);
		if (u === result.thiefUid) return result.correct ? 'green' : 'red';
		if (u === result.accusedUid) return 'dim';
		return 'none';
	}
</script>

<div class="card" style="padding:20px;">
	<div class="tf-head">
		<h2 class="section-title" style="margin:0;">🕵️ Thief Finder</h2>
		<div class="tf-head-right">
			<span class="chip chip--accent">Draw {game.draw}/{game.drawsTotal}</span>
			<button
				class="sound-btn"
				onclick={toggleMute}
				title={muted ? 'Sound off' : 'Sound on'}
				aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
			>
				{muted ? '🔇' : '🔊'}
			</button>
		</div>
	</div>

	{#if error}<p class="error-text">{error}</p>{/if}

	{#if game.phase === 'idle'}
		<p class="muted">Ready to deal the first draw.</p>
		{#if isHost}
			<button class="btn btn--primary" onclick={() => act('thief/deal')} disabled={busy}>Start game</button>
		{:else}
			<p class="muted">Waiting for the host to start…</p>
		{/if}
	{:else if game.phase === 'picking'}
		{#if game.policeUid}
			<div class="police-banner">
				<Avatar uid={game.policeUid} name={nameOf(game.policeUid)} size={44} ring="gold" glow />
				<div class="police-text">
					<span class="police-badge">👮 Police</span>
					<strong class="player-name">{nameOf(game.policeUid)}</strong>
				</div>
				<span class="muted police-hint">{isPolice ? 'That’s you!' : 'opened the police envelope'}</span>
			</div>
		{:else}
			<p class="muted">Someone holds the 👮 police card — open an envelope to find your role.</p>
		{/if}

		{#if amPlayer && game.myEnvelope != null && game.myRole}
			<div class="my-card fade-in">
				<span class="my-card-emoji">{ROLE_EMOJI[game.myRole]}</span>
				<div>
					<p class="label" style="margin:0;">Your card (secret)</p>
					<strong style="font-size:1.3rem;">{game.myRole}</strong>
				</div>
			</div>
		{/if}

		<div class="envelopes">
			{#each Array(game.envelopeCount) as _, k (k)}
				{@const holder = game.claims?.[k]}
				{@const mine = k === game.myEnvelope}
				<button
					class="envelope"
					class:envelope--mine={mine}
					class:envelope--taken={holder != null && !mine}
					disabled={busy || !amPlayer || holder != null || game.myEnvelope != null}
					onclick={() => act('thief/pick', { envelope: k })}
				>
					{#if mine}
						<span class="env-emoji">{ROLE_EMOJI[game.myRole]}</span>
						<span class="env-label">{game.myRole}</span>
					{:else if holder != null}
						<Avatar uid={Number(holder)} name={nameOf(holder)} size={40} />
						<span class="env-label">{nameOf(holder)}</span>
					{:else}
						<span class="env-emoji">✉️</span>
						<span class="env-label">#{k + 1}</span>
					{/if}
				</button>
			{/each}
		</div>

		{#if amPlayer && game.myEnvelope == null}
			<p class="muted pick-note">Tap an envelope to open it.</p>
		{:else if amPlayer}
			<p class="muted pick-note">Waiting for everyone to open an envelope…</p>
		{/if}
	{:else if game.phase === 'guessing'}
		{#if amPlayer && game.myRole}
			<div class="my-card fade-in">
				<span class="my-card-emoji">{ROLE_EMOJI[game.myRole]}</span>
				<div>
					<p class="label" style="margin:0;">Your card (secret)</p>
					<strong style="font-size:1.3rem;">{game.myRole}</strong>
				</div>
			</div>
		{/if}

		<div class="police-banner">
			<Avatar uid={game.policeUid} name={nameOf(game.policeUid)} size={44} ring="gold" glow />
			<div class="police-text">
				<span class="police-badge">👮 Police</span>
				<strong class="player-name">{nameOf(game.policeUid)}</strong>
			</div>
			<span class="muted police-hint">
				{isPolice ? 'That’s you — find the thief!' : 'Waiting for their guess…'}
			</span>
		</div>

		{#if isPolice}
			<div class="suspects">
				{#each game.players.filter((u) => u !== myUid) as uid (uid)}
					<button class="suspect" onclick={() => act('thief/guess', { accusedUid: uid })} disabled={busy}>
						<Avatar {uid} name={nameOf(uid)} size={56} ring="accent" />
						<span class="player-name">{nameOf(uid)}</span>
					</button>
				{/each}
			</div>
		{/if}
	{:else if game.phase === 'reveal' || game.phase === 'finished'}
		{#if result}
			{#snippet pill(uid, tone, badge)}
				<span class="pill pill--{tone}">
					<Avatar {uid} name={nameOf(uid)} size={26} />
					<strong>{nameOf(uid)}</strong>
					{#if badge}<span class="pill-badge">{badge}</span>{/if}
				</span>
			{/snippet}
			<div class="fade-in">
				<p class="verdict {result.correct ? 'verdict--good' : 'verdict--bad'}">
					{#if result.correct}
						<span class="verdict-mark">✅</span> Police caught the thief!
						{@render pill(result.thiefUid, 'green', '🥷 Thief')} is going down.
					{:else}
						<span class="verdict-mark">❌</span> Wrong guess! Police accused
						{@render pill(result.accusedUid, 'dim', 'innocent')}, but
						{@render pill(result.thiefUid, 'red', '🥷 Thief')} got away with the points!
					{/if}
				</p>
				<div class="reveal-grid">
					{#each Object.entries(result.roles) as [uid, role], i (uid)}
						<div class="reveal-row fade-in {revealClass(uid)}" style="--fade-delay:{i * 60}ms">
							<Avatar uid={Number(uid)} name={nameOf(uid)} size={34} ring={revealRing(uid)} />
							<span class="player-name">
								{nameOf(uid)}{Number(uid) === myUid ? ' (you)' : ''}
							</span>
							<span class="chip">{ROLE_EMOJI[role]} {role}</span>
							<span class="pts">+{result.points[uid]}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		{#if game.phase === 'reveal'}
			<div class="next-up">
				{#if secondsLeft > 0}
					<span class="tick">{secondsLeft}</span>
					<span>Next draw ({game.draw + 1}/{game.drawsTotal}) starting…</span>
				{:else}
					<span>Dealing draw {game.draw + 1}/{game.drawsTotal}…</span>
				{/if}
				<!-- auto-deal is host-driven; the host always keeps a manual override
				     so a failed or missed timer can never strand the room -->
				{#if isHost}
					<button class="btn btn--ghost btn--sm skip" onclick={() => act('thief/deal')} disabled={busy}>
						Skip ▶
					</button>
				{/if}
			</div>
		{:else}
			<p class="muted hold-note">🏁 Final draw — tallying up the leaderboard…</p>
		{/if}
	{/if}

	<h3 class="label" style="margin-top:20px;">Scores</h3>
	{#each sortedTotals as [uid, pts], i (uid)}
		<div class="score-row" class:score-row--mine={Number(uid) === myUid}>
			<span class="rank">{MEDAL[i] || i + 1}</span>
			<Avatar uid={Number(uid)} name={nameOf(uid)} size={32} ring={i === 0 ? 'gold' : 'none'} glow={i === 0} />
			<span class="player-name">{nameOf(uid)}{Number(uid) === myUid ? ' (you)' : ''}</span>
			<span class="pts">{pts}</span>
		</div>
	{/each}
</div>

<style>
	.tf-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 14px;
	}
	.tf-head-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.sound-btn {
		background: none;
		border: 1px solid var(--border);
		border-radius: 50%;
		width: 32px;
		height: 32px;
		font-size: 0.95rem;
		line-height: 1;
		cursor: pointer;
		color: var(--text);
	}
	.sound-btn:hover {
		border-color: var(--accent);
	}

	/* shared name treatment across suspects / reveal / scores */
	.player-name {
		font-family: var(--font-display);
		font-weight: 600;
		letter-spacing: 0.01em;
	}

	.my-card {
		display: flex;
		align-items: center;
		gap: 14px;
		background: var(--surface);
		border: 1px dashed var(--accent);
		border-radius: var(--radius);
		padding: 14px;
	}
	.my-card-emoji {
		font-size: 2.2rem;
	}

	.police-banner {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin: 16px 0;
		padding: 12px 14px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.police-text {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
	}
	.police-badge {
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--gold);
	}
	.police-text .player-name {
		font-size: 1.1rem;
	}
	.police-hint {
		margin-left: auto;
		font-size: 0.85rem;
	}

	.envelopes {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
		gap: 12px;
		margin: 8px 0 4px;
	}
	.envelope {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 96px;
		padding: 12px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		cursor: pointer;
		transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
	}
	.envelope:hover:not(:disabled) {
		transform: translateY(-2px);
		border-color: var(--accent);
		box-shadow: var(--shadow-sm);
	}
	.envelope:active:not(:disabled) {
		transform: scale(0.97);
	}
	.envelope:disabled {
		cursor: default;
	}
	.envelope--taken {
		opacity: 0.7;
		border-style: dashed;
	}
	.envelope--mine {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		opacity: 1;
	}
	.env-emoji {
		font-size: 1.9rem;
		line-height: 1;
	}
	.env-label {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text-dim);
	}
	.pick-note {
		margin-top: 8px;
		font-size: 0.88rem;
	}

	.suspects {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}
	.suspect {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 14px 18px;
		min-width: 104px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-size: 0.95rem;
		cursor: pointer;
		transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
	}
	.suspect:hover:not(:disabled) {
		transform: translateY(-2px);
		border-color: var(--accent);
		box-shadow: var(--shadow-sm);
	}
	.suspect:active:not(:disabled) {
		transform: scale(0.97);
	}
	.suspect:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.verdict {
		font-size: 1.05rem;
		/* generous leading so the inline avatar pills don't collide when the
		   sentence wraps onto a second line */
		line-height: 2.1;
		padding-left: 12px;
		border-left: 3px solid var(--border);
	}
	.verdict-mark {
		font-size: 1.2rem;
	}

	/* inline player chip: avatar + name, tinted by role in the verdict */
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 3px 12px 3px 3px;
		border-radius: 999px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		vertical-align: middle;
		line-height: 1;
		white-space: nowrap;
	}
	.pill strong {
		font-family: var(--font-display);
		font-weight: 700;
		letter-spacing: 0.01em;
		/* the tone colour is for the badge; the name stays full-contrast */
		color: var(--text);
	}
	.pill-badge {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		opacity: 0.85;
		padding-left: 2px;
		border-left: 1px solid currentColor;
		margin-left: 1px;
	}
	.pill--red {
		background: color-mix(in srgb, var(--red) 20%, transparent);
		border-color: color-mix(in srgb, var(--red) 55%, transparent);
		color: var(--red);
	}
	.pill--green {
		background: color-mix(in srgb, var(--green) 20%, transparent);
		border-color: color-mix(in srgb, var(--green) 55%, transparent);
		color: var(--green);
	}
	.pill--dim {
		background: var(--surface-2);
		border-color: var(--border);
		color: var(--text-dim);
	}
	.verdict--good {
		border-left-color: var(--green);
	}
	.verdict--bad {
		border-left-color: var(--red);
	}

	.reveal-grid {
		margin-top: 12px;
	}
	.reveal-row,
	.score-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
		border-radius: var(--radius-sm);
	}
	.reveal-row {
		border: 1px solid transparent;
		margin-bottom: 4px;
	}
	.row--caught {
		background: color-mix(in srgb, var(--green) 14%, transparent);
		border-color: color-mix(in srgb, var(--green) 40%, transparent);
	}
	.row--escaped {
		background: color-mix(in srgb, var(--red) 14%, transparent);
		border-color: color-mix(in srgb, var(--red) 40%, transparent);
	}
	.row--accused {
		background: var(--surface-2);
	}
	.score-row--mine {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.pts {
		margin-left: auto;
		font-weight: 700;
		font-size: 1.02rem;
		color: var(--gold);
	}
	.rank {
		width: 22px;
		text-align: center;
		color: var(--text-dim);
	}
	.hold-note {
		margin-top: 8px;
		font-size: 0.85rem;
	}
	.next-up {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 14px;
		color: var(--text-dim);
		font-size: 0.92rem;
	}
	.skip {
		margin-left: auto;
	}
	.tick {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		border: 1px solid var(--accent);
		color: var(--accent);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	@media (prefers-reduced-motion: reduce) {
		.suspect,
		.suspect:hover:not(:disabled),
		.suspect:active:not(:disabled) {
			transition: none;
			transform: none;
		}
	}
</style>

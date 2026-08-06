<script>
	import '@fontsource-variable/fredoka';
	import '@fontsource-variable/inter';
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { user, checkSession, logout } from '$lib/stores/auth.js';
	import Avatar from '$lib/components/Avatar.svelte';
	import { pushSupported, currentSubscription, subscribePush } from '$lib/push.js';
	import { startRing, arm } from '$lib/sound.js';

	let { children } = $props();

	// Incoming call: the SW forwards a call push to any open window so we can ring
	// out loud (a bare notification only chimes once) and offer Answer / Decline.
	let incoming = $state(null); // { title, body, url }
	let stopRing = null;
	let ringTimeout = null;
	function ringDown() {
		stopRing?.();
		stopRing = null;
		clearTimeout(ringTimeout);
	}
	function onSwMessage(e) {
		if (e.data?.type !== 'incoming-call') return;
		incoming = { title: e.data.title, body: e.data.body, url: e.data.url };
		ringDown();
		stopRing = startRing();
		ringTimeout = setTimeout(declineCall, 30000); // stop ringing after 30s
	}
	function answerCall() {
		const url = incoming?.url || '/';
		ringDown();
		incoming = null;
		goto(url);
	}
	function declineCall() {
		ringDown();
		incoming = null;
	}

	// 🔔 shows whenever the browser supports push but isn't confirmed subscribed.
	// Default 'off' (not 'unknown'): currentSubscription() waits for the SW to go
	// active — up to 30s on a first load — and gating the bell on that window is why
	// it used to appear only after a re-login. Offer it immediately; flip to 'on'
	// only once we positively see a subscription.
	const canPush = pushSupported();
	let pushState = $state('off'); // 'off' | 'on'
	async function refreshPushState() {
		if (!canPush) return;
		try {
			pushState = (await currentSubscription()) ? 'on' : 'off';
		} catch {
			pushState = 'off'; // uncertain → keep offering the bell
		}
	}
	async function enablePush() {
		try {
			await subscribePush();
			pushState = 'on';
		} catch (e) {
			alert(e.message);
		}
	}

	const PUBLIC_ROUTES = ['/login', '/signup'];
	const isPublic = (path) => PUBLIC_ROUTES.some((p) => path.startsWith(p));

	// Keepalive: re-sync the session every 10 min / on tab focus so the rotated
	// session id and sliding 30-day cookie never drift into logout.
	const KEEPALIVE_MS = 10 * 60 * 1000;
	function pingIfVisible() {
		if ($user && document.visibilityState === 'visible') checkSession();
	}

	onMount(() => {
		checkSession();
		arm(); // unlock the audio context on the first gesture, so a ring can sound
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').catch(() => {});
			navigator.serviceWorker.addEventListener('message', onSwMessage);
		}
		refreshPushState();
		document.addEventListener('visibilitychange', pingIfVisible);
		const t = setInterval(pingIfVisible, KEEPALIVE_MS);
		return () => {
			clearInterval(t);
			document.removeEventListener('visibilitychange', pingIfVisible);
			navigator.serviceWorker?.removeEventListener('message', onSwMessage);
			ringDown();
		};
	});

	// auth gate: once the session check settles, route guests to /signup — a
	// first-time visitor has no credentials, so the create-account page is the
	// friendlier landing. Returning users reach /login from the link there.
	$effect(() => {
		if ($user === null && !isPublic($page.url.pathname)) goto('/signup');
		if ($user && isPublic($page.url.pathname)) goto('/');
	});

	async function doLogout() {
		await logout();
		goto('/login');
	}
</script>

{#if incoming}
	<div class="call-toast" role="alertdialog" aria-label="Incoming call">
		<div class="call-toast-body">
			<span class="call-toast-title">{incoming.title}</span>
			<span class="call-toast-sub">{incoming.body}</span>
		</div>
		<div class="call-toast-actions">
			<button class="btn btn--primary btn--sm" onclick={answerCall}>📹 Answer</button>
			<button class="btn btn--ghost btn--sm" onclick={declineCall}>Decline</button>
		</div>
	</div>
{/if}

<div class="app" class:app--fill={$page.url.pathname === '/'}>
	{#if $user}
		<header class="topbar">
			<a class="brand" href="/">🎲 Gamerooms</a>
			<div class="topbar-right">
				<a href="/people" class="btn btn--ghost btn--sm" title="Find people">👥</a>
				{#if canPush && pushState !== 'on'}
					<button class="btn btn--ghost btn--sm" title="Enable notifications" onclick={enablePush}>🔔</button>
				{/if}
				<a href="/profile" class="profile-link" title="Profile">
					<Avatar uid={$user.uid} name={$user.name} size={30} />
					<span class="profile-name">{$user.name}</span>
				</a>
				<button class="btn btn--ghost btn--sm" onclick={doLogout}>Sign out</button>
			</div>
		</header>
	{/if}
	{@render children()}
</div>

<style>
	/* incoming-call banner — pinned top-centre, above everything */
	.call-toast {
		position: fixed;
		top: max(12px, env(safe-area-inset-top));
		left: 50%;
		transform: translateX(-50%);
		z-index: 2000;
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 12px 16px;
		border-radius: 14px;
		background: rgba(18, 22, 34, 0.96);
		color: #fff;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
		max-width: min(92vw, 460px);
		animation: call-pulse 1.2s ease-in-out infinite;
	}
	@keyframes call-pulse {
		0%, 100% { box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
		50% { box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 0 3px var(--accent, #ff4d6d); }
	}
	.call-toast-body {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.call-toast-title {
		font-weight: 700;
	}
	.call-toast-sub {
		font-size: 0.85rem;
		opacity: 0.8;
	}
	.call-toast-actions {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}
	@media (prefers-reduced-motion: reduce) {
		.call-toast {
			animation: none;
		}
	}

	/* Home is the only short page — fill the viewport so its footer credit can be
	   pushed to the bottom instead of floating in the middle of empty space. */
	.app--fill {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
		/* the credit sits at the very bottom here, so the roomy scroll-tail
		   padding the other pages use isn't wanted */
		padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
	}
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 0 18px;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-display);
		font-size: 1.4rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--text);
		text-decoration: none;
		padding: 4px 12px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
	}
	.topbar-right {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.profile-link {
		display: flex;
		align-items: center;
		gap: 8px;
		text-decoration: none;
		color: var(--text);
	}
	.profile-name {
		font-size: 0.9rem;
	}
	@media (max-width: 480px) {
		.profile-name {
			display: none;
		}
		.topbar {
			gap: 8px;
		}
		.topbar-right {
			gap: 8px;
		}
	}
</style>

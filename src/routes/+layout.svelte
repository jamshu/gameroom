<script>
	import '@fontsource-variable/fredoka';
	import '@fontsource-variable/inter';
	import '../app.css';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { user, checkSession, logout } from '$lib/stores/auth.js';
	import Avatar from '$lib/components/Avatar.svelte';
	import { pushSupported, currentSubscription, subscribePush } from '$lib/push.js';
	import { arm, startRing, stopRing } from '$lib/sound.js';

	let { children } = $props();

	// Incoming call, shown as an in-app banner while the app is ON-SCREEN. When
	// backgrounded/locked the OS notification (see sw.js) is the only audible path;
	// a suspended AudioContext can't ring anyway, so we only act while visible.
	let incomingCall = $state(null); // { url, text, tag } | null
	// A ring is a burst of pushes on one tag (see sw.js). Once answered/declined we
	// remember the tag so the rest of the burst doesn't re-open the banner.
	let handled = { tag: null, at: 0 };
	const HANDLED_MS = 20000; // > the ~10s burst
	function onSwMessage(e) {
		if (e.data?.type !== 'incoming-call') return;
		if (document.visibilityState !== 'visible') return;
		const tag = e.data.tag || '';
		if (tag && tag === handled.tag && Date.now() - handled.at < HANDLED_MS) return;
		incomingCall = { url: e.data.url || '/', text: e.data.body || 'Incoming call', tag };
		startRing();
	}
	function dismiss() {
		stopRing();
		if (incomingCall?.tag) handled = { tag: incomingCall.tag, at: Date.now() };
		incomingCall = null;
	}
	function answerCall() {
		const url = incomingCall?.url || '/';
		dismiss();
		goto(url);
	}
	function declineCall() {
		dismiss();
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
	// Coming back to the tab. Separate from the keepalive interval above on
	// purpose: a notification tapped while we were backgrounded left its
	// destination in the cache, and a RESUME is the only moment we get to act on
	// it — checking the cache every ten minutes on a timer would just be a
	// caches.open per tick that finds nothing.
	function onVisible() {
		pingIfVisible();
		if (document.visibilityState === 'visible') consumePendingNav();
	}

	// A tapped call/wave notification stashes its room URL in the Cache (see sw.js);
	// we consume it and route there. This is what lands the recipient IN the room
	// even on iOS PWAs, which otherwise always start on the dashboard.
	//
	// RUN ON RESUME AS WELL AS ON MOUNT, and that is the whole fix for "the
	// notification put me on the dashboard". Tapping a notification while the PWA
	// is merely backgrounded RESUMES the existing window — onMount does not run
	// again — and iOS ignores the URL handed to client.navigate()/openWindow(), so
	// the stashed destination was written and never read. Cold start worked; warm
	// resume, which is the common case, did not.
	const PENDING_NAV_MS = 5 * 60 * 1000;
	let consuming = false; // mount and visibilitychange can both fire at once
	async function consumePendingNav() {
		if (!('caches' in window) || consuming) return;
		consuming = true;
		try {
			const c = await caches.open('gr-nav');
			const res = await c.match('/__pending_nav');
			if (!res) return;
			const { url, at } = await res.json();
			if (!url || Date.now() - at > PENDING_NAV_MS) {
				await c.delete('/__pending_nav'); // genuinely stale — drop it
				return;
			}
			await goto(url);
			// DELETED ONLY ONCE WE ARE ACTUALLY THERE — goto resolving is not the same
			// as having stayed. On a cold start this runs while checkSession() is still
			// in flight, and the auth gate below redirects to /signup or / the moment it
			// settles; deleting on the strength of goto alone would throw the
			// destination away in exactly the race this ordering exists to survive.
			// Left in the cache, the next visibilitychange tries again.
			if (get(page).url.pathname === new URL(url, location.origin).pathname) {
				await c.delete('/__pending_nav');
			}
		} catch {
			/* no pending nav, or the cache is unavailable — nothing to do */
		} finally {
			consuming = false;
		}
	}

	onMount(() => {
		checkSession();
		arm(); // unlock the AudioContext on first gesture so the ring can play later
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').catch(() => {});
			navigator.serviceWorker.addEventListener('message', onSwMessage);
		}
		consumePendingNav();
		refreshPushState();
		document.addEventListener('visibilitychange', onVisible);
		const t = setInterval(pingIfVisible, KEEPALIVE_MS);
		return () => {
			clearInterval(t);
			document.removeEventListener('visibilitychange', onVisible);
			if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', onSwMessage);
			stopRing();
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

{#if incomingCall}
	<div class="call-banner" role="alertdialog" aria-label="Incoming call">
		<span class="call-banner__icon">📹</span>
		<span class="call-banner__text">{incomingCall.text}</span>
		<div class="call-banner__actions">
			<button class="btn btn--sm call-banner__answer" onclick={answerCall}>📹 Answer</button>
			<button class="btn btn--ghost btn--sm" onclick={declineCall}>Decline</button>
		</div>
	</div>
{/if}

<style>
	/* Incoming-call banner — fixed at the top, above everything, safe-area aware. */
	.call-banner {
		position: fixed;
		top: calc(12px + env(safe-area-inset-top, 0px));
		left: 50%;
		transform: translateX(-50%);
		z-index: 1000;
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: calc(100vw - 24px);
		padding: 12px 16px;
		border-radius: 16px;
		background: color-mix(in srgb, var(--accent) 22%, var(--bg, #0b1120));
		border: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
		animation: call-in 0.2s ease-out;
	}
	@keyframes call-in {
		from { transform: translate(-50%, -12px); opacity: 0; }
		to { transform: translate(-50%, 0); opacity: 1; }
	}
	.call-banner__icon {
		font-size: 1.4rem;
	}
	.call-banner__text {
		font-weight: 600;
		color: var(--text);
	}
	.call-banner__actions {
		display: flex;
		gap: 8px;
	}
	.call-banner__answer {
		background: #16a34a;
		color: #fff;
	}
	@media (max-width: 480px) {
		.call-banner {
			flex-wrap: wrap;
			justify-content: center;
			text-align: center;
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

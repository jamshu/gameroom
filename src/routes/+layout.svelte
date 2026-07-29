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

	let { children } = $props();

	// 🔔 shows only when the browser supports push but isn't subscribed yet.
	let pushState = $state('unknown'); // 'unknown' | 'off' | 'on'
	async function refreshPushState() {
		if (!pushSupported()) return;
		pushState = (await currentSubscription()) ? 'on' : 'off';
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
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
		refreshPushState();
		document.addEventListener('visibilitychange', pingIfVisible);
		const t = setInterval(pingIfVisible, KEEPALIVE_MS);
		return () => {
			clearInterval(t);
			document.removeEventListener('visibilitychange', pingIfVisible);
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
				{#if pushState === 'off'}
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

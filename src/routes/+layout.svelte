<script>
	import '@fontsource-variable/fraunces';
	import '@fontsource-variable/inter';
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { user, checkSession, logout } from '$lib/stores/auth.js';
	import Avatar from '$lib/components/Avatar.svelte';

	let { children } = $props();

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

<div class="app">
	{#if $user}
		<header class="topbar">
			<a class="brand" href="/">🎲 Gamerooms</a>
			<div class="topbar-right">
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
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 0 18px;
	}
	.brand {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--text);
		text-decoration: none;
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
	}
</style>

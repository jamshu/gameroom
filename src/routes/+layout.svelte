<script>
	import '@fontsource-variable/fraunces';
	import '@fontsource-variable/inter';
	import '../app.css';
	import { onMount } from 'svelte';
	import { profile, initProfile } from '$lib/stores/profile.js';
	import Avatar from '$lib/components/Avatar.svelte';
	import ProfileModal from '$lib/components/ProfileModal.svelte';

	let { children } = $props();
	let editing = $state(false);

	onMount(() => {
		initProfile();
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
	});
</script>

<div class="app">
	{#if $profile}
		<header class="topbar">
			<a class="brand" href="/">🎲 Gamerooms</a>
			<div class="topbar-right">
				<button class="profile-link" onclick={() => (editing = true)} title="Edit profile">
					<Avatar uid={$profile.uid} name={$profile.name} size={30} />
					<span class="profile-name">{$profile.name}</span>
				</button>
			</div>
		</header>
		{@render children()}
	{/if}

	<!-- first visit ($profile === null) or editing → capture name + avatar -->
	{#if $profile === null || editing}
		<ProfileModal initialName={$profile?.name || ''} onDone={() => (editing = false)} />
	{/if}
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
		background: none;
		border: none;
		cursor: pointer;
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

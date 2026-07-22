<script>
	// User avatar: served through the proxy; falls back to an initial on a tinted
	// disc. `bump` cache-busts after the user uploads a new picture.
	let { uid, name = '', size = 32, bump = 0 } = $props();
	let failed = $state(false);

	const initial = $derived((name || '?').trim().charAt(0).toUpperCase());
	const hue = $derived(((uid || 0) * 47) % 360);
</script>

{#if uid && !failed}
	<img
		class="avatar"
		style="width:{size}px;height:{size}px"
		src={`/api/avatar/${uid}${bump ? `?b=${bump}` : ''}`}
		alt={name}
		onerror={() => (failed = true)}
	/>
{:else}
	<span
		class="avatar avatar--fallback"
		style="width:{size}px;height:{size}px;background:hsl({hue} 45% 40%);font-size:{size * 0.45}px"
		>{initial}</span
	>
{/if}

<style>
	.avatar {
		border-radius: 50%;
		object-fit: cover;
		background: var(--surface);
		flex-shrink: 0;
	}
	.avatar--fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: #fff;
		font-weight: 600;
	}
</style>

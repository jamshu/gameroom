<script>
	// User avatar: served through the proxy; falls back to an initial on a tinted
	// disc. `bump` cache-busts after the user uploads a new picture.
	// `ring`/`glow` are opt-in accents (default off) so existing call sites keep
	// their plain look.
	let { uid, name = '', size = 32, bump = 0, ring = 'none', glow = false } = $props();
	let failed = $state(false);

	const initial = $derived((name || '?').trim().charAt(0).toUpperCase());
	// uid is a uuid string — hash it to a stable hue.
	const hue = $derived([...String(uid || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));

	// ring width scales with the avatar so small ones don't get swallowed
	const rw = $derived(size >= 44 ? 3 : 2);
	const ringStyle = $derived(
		ring === 'none'
			? ''
			: `box-shadow: 0 0 0 ${rw}px var(--bg), 0 0 0 ${rw + 2}px var(--ring-c)` +
				(glow ? `, 0 0 14px -2px var(--ring-c)` : '') +
				';'
	);
</script>

{#if uid && !failed}
	<img
		class="avatar ring--{ring}"
		style="width:{size}px;height:{size}px;{ringStyle}"
		src={`/api/avatar/${uid}${bump ? `?b=${bump}` : ''}`}
		alt={name}
		onerror={() => (failed = true)}
	/>
{:else}
	<span
		class="avatar avatar--fallback ring--{ring}"
		style="width:{size}px;height:{size}px;background:hsl({hue} 45% 40%);font-size:{size *
			0.45}px;{ringStyle}"
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
	/* --ring-c feeds the inline box-shadow above */
	.ring--accent {
		--ring-c: var(--accent);
	}
	.ring--gold {
		--ring-c: var(--gold);
	}
	.ring--red {
		--ring-c: var(--red);
	}
	.ring--green {
		--ring-c: var(--green);
	}
	.ring--dim {
		--ring-c: var(--border);
	}
</style>

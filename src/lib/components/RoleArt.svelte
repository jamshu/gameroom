<script>
	// Role badge: a landscape meme thumbnail when the role has art on disk,
	// otherwise its emoji. Same load-failure shape as Avatar.svelte — onerror
	// flips to the fallback — plus a module-level memo in roles.js so a missing
	// file is requested once per session, not once per instance.
	import { ROLE_EMOJI, artSrc, markDead } from '$lib/roles.js';

	// `em` is the emoji size for the fallback branch; it defaults to something
	// sensible for the box so most call sites don't have to think about it.
	let { role, w = 44, h = 30, em = 0 } = $props();
	let failed = $state(false);

	const src = $derived(failed ? null : artSrc(role));
	const glyph = $derived(ROLE_EMOJI[role]);
	const size = $derived(em || Math.round(h * 0.78));
</script>

{#if role}
	{#if src}
		<!-- decorative: every call site renders the role name as adjacent text, so
		     an alt here would just double-announce it -->
		<img
			class="role-art"
			style="width:{w}px;height:{h}px;"
			{src}
			alt=""
			onerror={() => {
				markDead(role);
				failed = true;
			}}
		/>
	{:else if glyph}
		<span class="role-art role-art--emo emo" style="font-size:{size}px;">{glyph}</span>
	{/if}
{/if}

<style>
	.role-art {
		object-fit: cover;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		flex-shrink: 0;
		/* keeps a thumbnail from dragging the baseline around when it sits inline
		   in the verdict sentence or a chip */
		vertical-align: middle;
		line-height: 1;
	}
	.role-art--emo {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: none;
	}
</style>

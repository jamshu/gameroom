<script>
	/**
	 * The 🎨 panel shared by every board, so chess, ludo and carroms present the
	 * same affordance instead of three lookalike copies.
	 *
	 * groups: [{ label, options, selected, onselect }]
	 *   option: { id, label, swatch }
	 *   swatch: { colors: [hex, …] }  — a strip of colour chips
	 *        or { img: src }          — a preview image (chess piece sets)
	 */
	let { groups } = $props();
</script>

<div class="themes">
	{#each groups as g (g.label)}
		<p class="themes-label">{g.label}</p>
		<div class="swatches">
			{#each g.options as o (o.id)}
				<button
					class="sw"
					class:sw--on={g.selected === o.id}
					onclick={() => g.onselect(o.id)}
					aria-pressed={g.selected === o.id}
					title={o.label}
				>
					{#if o.swatch?.colors}
						<span class="sw-chips">
							{#each o.swatch.colors as c (c)}<i style="background:{c}"></i>{/each}
						</span>
					{:else if o.swatch?.img}
						<img class="sw-pc" src={o.swatch.img} alt="" />
					{/if}
					{o.label}
				</button>
			{/each}
		</div>
	{/each}
</div>

<style>
	.themes {
		margin-top: 12px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}
	.themes-label {
		margin: 0 0 8px;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-dim);
	}
	.swatches {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.swatches:not(:last-child) {
		margin-bottom: 14px;
	}
	.sw {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 5px 11px 5px 7px;
		font: inherit;
		font-size: 0.82rem;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
	}
	.sw:hover {
		border-color: var(--accent);
	}
	.sw--on {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.sw-chips {
		display: flex;
		border-radius: 3px;
		overflow: hidden;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.16);
	}
	.sw-chips i {
		width: 13px;
		height: 13px;
		display: block;
	}
	.sw-pc {
		width: 18px;
		height: 18px;
	}
</style>

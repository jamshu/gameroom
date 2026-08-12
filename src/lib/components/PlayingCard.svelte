<script>
	// One playing card, CSS-only. Shared by every card game's board AND their solo
	// pages — the app has no card art, so this is the whole deck's look. A face-down
	// card is a rival's card or the stock; `selectable` + `onclick` make it a button.
	import { rankLabel, suitGlyph, isRed } from '$lib/shared/cards.js';

	let {
		card = null, // { r, s } or null when faceDown
		faceDown = false,
		selectable = false,
		disabled = false,
		small = false,
		onclick = null
	} = $props();

	const red = $derived(!faceDown && card && isRed(card.s));
</script>

<button
	type="button"
	class="card"
	class:down={faceDown}
	class:red
	class:small
	class:selectable
	disabled={disabled || !selectable}
	onclick={() => selectable && onclick?.(card)}
	aria-label={faceDown ? 'face-down card' : `${rankLabel(card?.r)} of ${suitGlyph(card?.s)}`}
>
	{#if !faceDown && card}
		<span class="corner tl">{rankLabel(card.r)}{suitGlyph(card.s)}</span>
		<span class="pip">{suitGlyph(card.s)}</span>
		<span class="corner br">{rankLabel(card.r)}{suitGlyph(card.s)}</span>
	{/if}
</button>

<style>
	.card {
		position: relative;
		width: 76px;
		height: 108px;
		border-radius: 9px;
		border: 1px solid var(--border);
		background: #fff;
		color: #111;
		padding: 0;
		font-family: inherit;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
		flex: 0 0 auto;
		cursor: default;
	}
	.card.small {
		width: 58px;
		height: 82px;
		border-radius: 7px;
	}
	.card.red {
		color: #c0392b;
	}
	.card.selectable:not(:disabled) {
		cursor: pointer;
	}
	.card.selectable:not(:disabled):hover {
		transform: translateY(-6px);
		box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
	}
	.card:disabled {
		opacity: 1; /* a non-selectable card is just static, not greyed */
	}
	.card.selectable:disabled {
		opacity: 0.45; /* an illegal-to-play card IS greyed */
	}
	.card.down {
		background: repeating-linear-gradient(45deg, #2b4a8b, #2b4a8b 6px, #37589e 6px, #37589e 12px);
		border-color: #21386b;
	}
	.corner {
		position: absolute;
		font-size: 18px;
		font-weight: 700;
		line-height: 1;
	}
	.small .corner {
		font-size: 14px;
	}
	.tl {
		top: 6px;
		left: 6px;
	}
	.br {
		bottom: 6px;
		right: 6px;
		transform: rotate(180deg);
	}
	.pip {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-size: 44px;
	}
	.small .pip {
		font-size: 32px;
	}
</style>

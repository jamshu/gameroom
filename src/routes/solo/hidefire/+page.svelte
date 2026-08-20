<script>
	// Solo Hide & Fire — offline practice vs one AI bot. No room, no login, no
	// Durable Object: HideFireArena runs its own round via shared/hidefire.js and
	// Godot spawns the bot. This is also the only way to see the opponent avatar
	// without deploying (the peer relay needs the Worker's DO).
	import HideFireArena from '$lib/components/HideFireArena.svelte';
</script>

<svelte:head><title>Hide &amp; Fire — Practice</title></svelte:head>

<main class="wrap">
	<a class="back" href="/">← Home</a>
	<h1>🔫 Hide &amp; Fire — practice vs bot</h1>
	<p class="hint">
		Paint your white body to blend into the stage, then hold a pose. Or seek and
		fire before the timer runs out. Sides switch each round.
	</p>
	<HideFireArena solo />
</main>

<style>
	.wrap { max-width: 960px; margin: 0 auto; padding: 16px; }
	.back { color: #7c3aed; text-decoration: none; font-size: 14px; }
	h1 { font-size: 20px; margin: 8px 0 4px; }
	.hint { color: #6b7280; font-size: 13px; margin: 0 0 12px; }
</style>

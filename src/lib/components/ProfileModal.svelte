<script>
	import { saveProfile } from '$lib/stores/profile.js';

	// `initial` prefills when editing an existing profile.
	let { initialName = '', onDone = () => {} } = $props();

	let name = $state(initialName);
	let avatarB64 = $state(null); // ≤512px base64, or null to keep existing
	let preview = $state(null);
	let busy = $state(false);
	let error = $state('');

	function autofocus(node) {
		node.focus();
	}

	/** Resize client-side to 512px square so the upload stays tiny. */
	function resize(file) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const S = 512;
				const c = document.createElement('canvas');
				const side = Math.min(img.width, img.height);
				c.width = c.height = Math.min(S, side);
				const ctx = c.getContext('2d');
				ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height);
				resolve(c.toDataURL('image/jpeg', 0.85));
			};
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

	async function pick(e) {
		const file = e.target.files?.[0];
		if (!file) return;
		error = '';
		try {
			const dataUrl = await resize(file);
			preview = dataUrl;
			avatarB64 = dataUrl.split(',')[1];
		} catch {
			error = 'Could not read that image';
		}
	}

	async function submit(e) {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			await saveProfile({ name, avatar: avatarB64 });
			onDone();
		} catch (e2) {
			error = e2.message;
		} finally {
			busy = false;
		}
	}
</script>

<div class="overlay">
	<div class="card modal">
		<h2 class="section-title" style="margin-top:0;">👋 Pick a name</h2>
		<p class="muted" style="margin-top:-6px;">Stored on this device — no sign-up.</p>
		<form onsubmit={submit}>
			<label class="label" for="pm-name">Name</label>
			<input id="pm-name" class="input" bind:value={name} maxlength="40" required use:autofocus />

			<span class="label" style="display:block; margin-top:12px;">Avatar (optional)</span>
			<div class="avatar-row">
				{#if preview}
					<img class="preview" src={preview} alt="avatar preview" />
				{:else}
					<span class="preview preview--empty">{(name || '?').trim().charAt(0).toUpperCase()}</span>
				{/if}
				<label class="btn btn--ghost btn--sm file-btn">
					Choose image
					<input type="file" accept="image/*" onchange={pick} hidden />
				</label>
			</div>

			{#if error}<p class="error-text">{error}</p>{/if}
			<button class="btn btn--primary" style="margin-top:16px; width:100%;" disabled={busy}>
				{busy ? 'Saving…' : 'Enter'}
			</button>
		</form>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--bg) 80%, black);
		z-index: 100;
		padding: 20px;
	}
	.modal {
		width: 100%;
		max-width: 380px;
		padding: 24px;
	}
	.avatar-row {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.preview {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		object-fit: cover;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--surface-2, var(--surface));
		color: var(--text);
		font-weight: 600;
		font-size: 1.4rem;
		border: 1px solid var(--border);
	}
	.file-btn {
		cursor: pointer;
	}
</style>

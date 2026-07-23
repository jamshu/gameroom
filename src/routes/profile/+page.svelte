<script>
	import { profile, saveProfile } from '$lib/stores/profile.js';
	import Avatar from '$lib/components/Avatar.svelte';

	let name = $state('');
	let saving = $state(false);
	let msg = $state('');
	let error = $state('');
	let bump = $state(0);
	let avatarB64 = $state(null);
	let fileInput = $state(null);

	$effect(() => {
		if ($profile && !name) name = $profile.name;
	});

	/** Resize client-side to 512px square; returns base64 (no data-url prefix). */
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
				resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
			};
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

	async function pickPhoto(e) {
		const file = e.target.files?.[0];
		if (!file) return;
		msg = error = '';
		try {
			avatarB64 = await resize(file);
			bump = Date.now();
			msg = 'Photo ready — Save to apply';
		} catch {
			error = 'Could not read that image';
		} finally {
			e.target.value = '';
		}
	}

	async function save(e) {
		e.preventDefault();
		saving = true;
		msg = error = '';
		try {
			await saveProfile({ name, avatar: avatarB64 });
			avatarB64 = null;
			bump = Date.now();
			msg = 'Saved';
		} catch (e2) {
			error = e2.message;
		} finally {
			saving = false;
		}
	}
</script>

<div class="fade-in" style="max-width:440px; margin:0 auto;">
	<h1 class="section-title">Profile</h1>
	<div class="card" style="padding:24px;">
		<div class="avatar-row">
			<Avatar uid={$profile?.uid} name={name || $profile?.name} size={72} {bump} />
			<button class="btn btn--ghost btn--sm" onclick={() => fileInput.click()}>Change photo</button>
			<input type="file" accept="image/*" hidden bind:this={fileInput} onchange={pickPhoto} />
		</div>

		<form onsubmit={save} style="margin-top:20px;">
			<label class="label" for="pname">Display name</label>
			<input id="pname" class="input" bind:value={name} required maxlength="80" />
			{#if error}<p class="error-text">{error}</p>{/if}
			{#if msg}<p class="chip chip--green">{msg}</p>{/if}
			<button class="btn btn--primary" style="margin-top:14px;" disabled={saving}>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</form>
	</div>
</div>

<style>
	.avatar-row {
		display: flex;
		align-items: center;
		gap: 18px;
	}
</style>

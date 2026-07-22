<script>
	import { user, checkSession } from '$lib/stores/auth.js';
	import { api } from '$lib/api.js';
	import Avatar from '$lib/components/Avatar.svelte';

	let name = $state('');
	let saving = $state(false);
	let uploading = $state(false);
	let msg = $state('');
	let error = $state('');
	let bump = $state(0);
	let fileInput = $state(null);

	$effect(() => {
		if ($user && !name) name = $user.name;
	});

	async function saveName(e) {
		e.preventDefault();
		saving = true;
		msg = error = '';
		try {
			await api('/api/profile', { method: 'POST', body: { name } });
			await checkSession();
			msg = 'Saved';
		} catch (e2) {
			error = e2.message;
		} finally {
			saving = false;
		}
	}

	/** Resize client-side to 512px so the upload stays tiny. */
	function resize(file) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const S = 512;
				const c = document.createElement('canvas');
				const scale = Math.max(S / img.width, S / img.height);
				c.width = Math.min(S, Math.round(img.width * scale));
				c.height = Math.min(S, Math.round(img.height * scale));
				const ctx = c.getContext('2d');
				// center-crop square
				const side = Math.min(img.width, img.height);
				ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height);
				resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
			};
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

	async function upload(e) {
		const file = e.target.files?.[0];
		if (!file) return;
		uploading = true;
		msg = error = '';
		try {
			const dataBase64 = await resize(file);
			await api('/api/avatar', { method: 'POST', body: { dataBase64 } });
			bump = Date.now(); // cache-bust the avatar image
			msg = 'Photo updated';
		} catch (e2) {
			error = e2.message;
		} finally {
			uploading = false;
			e.target.value = '';
		}
	}
</script>

<div class="fade-in" style="max-width:440px; margin:0 auto;">
	<h1 class="section-title">Profile</h1>
	<div class="card" style="padding:24px;">
		<div class="avatar-row">
			<Avatar uid={$user?.uid} name={$user?.name} size={72} {bump} />
			<div>
				<button class="btn btn--ghost btn--sm" onclick={() => fileInput.click()} disabled={uploading}>
					{uploading ? 'Uploading…' : 'Change photo'}
				</button>
				<input type="file" accept="image/*" hidden bind:this={fileInput} onchange={upload} />
			</div>
		</div>

		<form onsubmit={saveName} style="margin-top:20px;">
			<label class="label" for="pname">Display name</label>
			<input id="pname" class="input" bind:value={name} required maxlength="80" />
			<label class="label" style="margin-top:12px;">Login</label>
			<p class="muted">{$user?.login}</p>
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

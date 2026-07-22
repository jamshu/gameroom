<script>
	import { goto } from '$app/navigation';
	import { signup } from '$lib/stores/auth.js';

	let name = $state('');
	let loginId = $state('');
	let password = $state('');
	let error = $state('');
	let busy = $state(false);

	async function submit(e) {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			await signup(name, loginId, password);
			goto('/');
		} catch (err) {
			error = err.message;
		} finally {
			busy = false;
		}
	}
</script>

<div class="auth-wrap fade-in">
	<h1><span class="emo">🎲</span> Gamerooms</h1>
	<p class="muted" style="margin: 8px 0 26px;">Create your account.</p>
	<form class="card auth-card" onsubmit={submit}>
		<label class="label" for="name">Name</label>
		<input id="name" class="input" type="text" bind:value={name} autocomplete="name" required />
		<label class="label" for="login">Email or mobile</label>
		<input id="login" class="input" type="text" bind:value={loginId} autocomplete="username" required />
		<label class="label" for="password">Password</label>
		<input id="password" class="input" type="password" bind:value={password} autocomplete="new-password" minlength="6" required />
		{#if error}<p class="error-text">{error}</p>{/if}
		<button class="btn btn--primary" style="width:100%; margin-top:20px;" disabled={busy}>
			{busy ? 'Creating…' : 'Sign up'}
		</button>
		<p class="muted" style="margin-top:16px; text-align:center;">
			Already have an account? <a href="/login">Sign in</a>
		</p>
	</form>
</div>

<style>
	.auth-wrap {
		max-width: 400px;
		margin: 12vh auto 0;
		text-align: center;
	}
	.auth-card {
		padding: 26px;
		text-align: left;
	}
	.auth-card a {
		color: var(--accent);
	}
</style>

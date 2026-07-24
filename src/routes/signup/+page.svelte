<script>
	import { goto } from '$app/navigation';
	import { signup } from '$lib/stores/auth.js';

	// Mirrors the server rules in /api/auth/signup so the client never rejects
	// something the server would accept (or vice versa).
	const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const MOBILE_RE = /^\+?[0-9][0-9\s-]{6,14}$/;

	let name = $state('');
	let loginId = $state('');
	let password = $state('');
	let showPw = $state(false);
	let error = $state('');
	let busy = $state(false);

	// Errors only surface once a field has been left — nothing turns red while
	// you're still typing the first character.
	let touched = $state({ name: false, login: false, password: false });
	const touch = (f) => (touched[f] = true);

	const nameErr = $derived(name.trim() ? '' : 'Tell us what to call you.');
	const loginErr = $derived(
		EMAIL_RE.test(loginId.trim()) || MOBILE_RE.test(loginId.trim())
			? ''
			: 'Enter a valid email address or mobile number.'
	);
	const pwErr = $derived(password.length >= 6 ? '' : 'At least 6 characters.');
	const valid = $derived(!nameErr && !loginErr && !pwErr);

	async function submit(e) {
		e.preventDefault();
		touched = { name: true, login: true, password: true };
		if (!valid) return;
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
	<p class="muted" style="margin: 8px 0 26px;">
		Play together. Talk live. Create your account — it takes a few seconds.
	</p>
	<form class="card auth-card" onsubmit={submit}>
		<label class="label" for="name">Name</label>
		<input
			id="name"
			class="input"
			class:invalid={touched.name && nameErr}
			type="text"
			bind:value={name}
			onblur={() => touch('name')}
			autocomplete="name"
			required
		/>
		{#if touched.name && nameErr}
			<p class="hint hint--err">{nameErr}</p>
		{:else}
			<p class="hint">This is what other players will see.</p>
		{/if}

		<label class="label" for="login">Email or mobile</label>
		<input
			id="login"
			class="input"
			class:invalid={touched.login && loginErr}
			type="text"
			bind:value={loginId}
			onblur={() => touch('login')}
			autocomplete="username"
			required
		/>
		{#if touched.login && loginErr}
			<p class="hint hint--err">{loginErr}</p>
		{:else}
			<p class="hint">Use either — it's how you sign in.</p>
		{/if}

		<label class="label" for="password">Password</label>
		<div class="pw-wrap">
			<!-- Svelte can't bind:value on a dynamic `type`, so bind by hand — one
			     input means focus and cursor survive the show/hide toggle. -->
			<input
				id="password"
				class="input pw-input"
				class:invalid={touched.password && pwErr}
				type={showPw ? 'text' : 'password'}
				value={password}
				oninput={(e) => (password = e.currentTarget.value)}
				onblur={() => touch('password')}
				autocomplete="new-password"
				minlength="6"
				required
			/>
			<button
				type="button"
				class="pw-toggle"
				tabindex="-1"
				aria-label={showPw ? 'Hide password' : 'Show password'}
				onclick={() => (showPw = !showPw)}
			>
				<span class="emo">{showPw ? '🙈' : '👁'}</span>
			</button>
		</div>
		{#if touched.password && pwErr}
			<p class="hint hint--err">{pwErr}</p>
		{:else}
			<p class="hint">At least 6 characters.</p>
		{/if}

		{#if error}<p class="error-text">{error}</p>{/if}
		<button class="btn btn--primary go" disabled={busy || !valid}>
			{busy ? 'Creating…' : 'Go'}
		</button>

		<div class="divider"><span>Already have an account?</span></div>
		<a href="/login" class="btn signin">Sign in</a>
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
	.hint {
		margin: 6px 2px 0;
		font-size: 0.78rem;
		color: var(--text-faint);
	}
	.hint--err {
		color: var(--red);
	}
	.input.invalid {
		border-color: var(--red);
	}
	.pw-wrap {
		position: relative;
	}
	.pw-input {
		padding-right: 44px;
	}
	.pw-toggle {
		position: absolute;
		top: 50%;
		right: 6px;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border-radius: var(--radius-sm);
		font-size: 1.1rem;
		opacity: 0.7;
	}
	.pw-toggle:hover {
		opacity: 1;
	}
	.go {
		width: 100%;
		margin-top: 22px;
	}
	.divider {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 24px 0 14px;
		font-size: 0.8rem;
		color: var(--text-dim);
	}
	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: linear-gradient(
			90deg,
			transparent,
			color-mix(in srgb, var(--ornament) 55%, transparent),
			transparent
		);
	}
	.signin {
		width: 100%;
		text-decoration: none;
	}
</style>

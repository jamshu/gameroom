/**
 * Fullscreen toggle for a game board, shared by the chess/carroms/ludo boards.
 *
 * iOS Safari refuses `requestFullscreen` on non-<video> elements, and on Android
 * the native API fights our `position:fixed` overlay (safe-area insets read 0 in
 * the top layer), so on touch devices we skip the native API entirely and let a
 * plain CSS overlay carry it — `isFs` drives that overlay and applies immediately.
 * The native API is only *additionally* used on desktop/non-touch where it works.
 *
 * Mirrors the `create*` rune-module pattern used by createChessClock: call it once
 * during component init, pass a getter for the element to fullscreen, and bind the
 * returned `isFs`/`toggle` in the markup.
 */
export function createFullscreen(getEl) {
	let isFs = $state(false);
	let nativeFs = false; // plain let — must not drive rendering

	const canNativeFs = () =>
		typeof window !== 'undefined' &&
		window.matchMedia &&
		!window.matchMedia('(pointer: coarse)').matches;

	async function toggle() {
		if (!isFs) {
			isFs = true; // CSS fallback applies immediately either way
			try {
				const el = getEl?.();
				if (canNativeFs() && el?.requestFullscreen) {
					await el.requestFullscreen();
					nativeFs = true;
				}
			} catch {
				nativeFs = false; // refused (or iOS) — the CSS fallback still covers us
			}
		} else {
			isFs = false;
			if (nativeFs && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
			nativeFs = false;
		}
	}

	// The browser's own chrome (Esc, F11) can exit native fullscreen without us —
	// keep our flag in sync or the CSS overlay would strand the board full-bleed.
	$effect(() => {
		const sync = () => {
			if (nativeFs && !document.fullscreenElement) {
				nativeFs = false;
				isFs = false;
			}
		};
		document.addEventListener('fullscreenchange', sync);
		return () => document.removeEventListener('fullscreenchange', sync);
	});

	$effect(() => {
		if (!isFs) return;
		const onKey = (e) => {
			if (e.key === 'Escape') isFs = false;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	return {
		get isFs() {
			return isFs;
		},
		toggle
	};
}

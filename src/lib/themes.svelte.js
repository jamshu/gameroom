/**
 * Colour themes for ludo and carroms, persisted to localStorage.
 *
 * Same shape and stale-id handling as `createChessTheme` in chessthemes.svelte.js
 * — kept separate because chess has two independent axes (board + piece set) and
 * a `src()` helper that neither of these needs.
 *
 * Ludo themes only re-map what the four colour NAMES look like. The server hands
 * out `red`/`green`/`yellow`/`blue` as seat identity, so a theme is purely a
 * rendering choice — nothing about the game changes.
 */

export const LUDO_THEMES = [
	// `classic` must stay byte-identical to the --ludo-* values in app.css, or
	// switching to it wouldn't return the board to how players remember it.
	{ id: 'classic', label: 'Classic', colors: { red: '#e5484d', green: '#30a46c', yellow: '#f5c518', blue: '#3b82f6' } },
	{ id: 'pastel', label: 'Pastel', colors: { red: '#ef9a9a', green: '#8fcfae', yellow: '#f3dc8c', blue: '#9dbdf5' } },
	{ id: 'neon', label: 'Neon', colors: { red: '#ff2d55', green: '#00e676', yellow: '#ffea00', blue: '#2979ff' } },
	// Okabe–Ito: distinguishable under the common forms of colour blindness, where
	// the classic red/green pair is the hardest to tell apart.
	{ id: 'accessible', label: 'Accessible', colors: { red: '#d55e00', green: '#009e73', yellow: '#f0e442', blue: '#0072b2' } }
];

export const CARROM_THEMES = [
	// `maple` reproduces the hexes that were inline in CarromBoard's draw().
	{
		id: 'maple',
		label: 'Maple',
		palette: {
			felt: '#e9d3a3', frame: '#8a5a2b', line: '#c09a5a', pocket: '#3a2410',
			white: '#f7f1e1', black: '#2d2a26', queen: '#c0392b', striker: '#4a6fa5'
		}
	},
	{
		id: 'walnut',
		label: 'Walnut',
		palette: {
			felt: '#d8b98c', frame: '#4e2f18', line: '#a67c47', pocket: '#241407',
			white: '#faf3e3', black: '#211f1c', queen: '#b03a2e', striker: '#2f6f6f'
		}
	},
	{
		id: 'slate',
		label: 'Slate',
		palette: {
			felt: '#cfd6dd', frame: '#2f3b47', line: '#8fa0b0', pocket: '#16202a',
			white: '#ffffff', black: '#1b2430', queen: '#e05252', striker: '#7c3aed'
		}
	},
	{
		id: 'emerald',
		label: 'Emerald',
		palette: {
			felt: '#cfe4d2', frame: '#1f4d33', line: '#7fae90', pocket: '#10251a',
			white: '#fbfff9', black: '#16241c', queen: '#d94f4f', striker: '#d99b30'
		}
	}
];

/**
 * One selection, persisted. `themes[0]` is the default and the fallback for a
 * stored id we no longer recognise — without that guard, removing a theme would
 * leave whoever had it selected with an unstyled board.
 */
export function createTheme({ key, themes }) {
	let id = $state(read());

	function read() {
		if (typeof localStorage === 'undefined') return themes[0].id;
		try {
			const stored = localStorage.getItem(key);
			return themes.some((t) => t.id === stored) ? stored : themes[0].id;
		} catch {
			return themes[0].id;
		}
	}

	return {
		get id() {
			return id;
		},
		get current() {
			return themes.find((t) => t.id === id) || themes[0];
		},
		/** CSS custom properties for a `colors`-style theme (ludo). */
		get style() {
			const c = this.current.colors;
			if (!c) return '';
			return Object.entries(c)
				.map(([name, hex]) => `--ludo-${name}:${hex}`)
				.join('; ');
		},
		set(next) {
			if (!themes.some((t) => t.id === next)) return;
			id = next;
			try {
				localStorage.setItem(key, next);
			} catch {
				// private mode / quota — the choice just won't survive a reload
			}
		}
	};
}

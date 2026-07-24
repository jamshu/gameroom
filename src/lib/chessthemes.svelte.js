/**
 * Board colour themes + piece sets for the chess board, with the player's choice
 * persisted to localStorage.
 *
 * Board colours are applied as CSS custom properties (`--sq-l` / `--sq-d`) so a
 * theme switch is a two-property write rather than a re-render of 64 squares.
 * Piece sets are directories under `static/pieces/<id>/` — see
 * `static/pieces/LICENSES.md` before adding one.
 */

export const BOARD_THEMES = [
	{ id: 'meadow', label: 'Meadow', light: '#ebecd0', dark: '#779556' },
	{ id: 'boxwood', label: 'Boxwood', light: '#f0d9b5', dark: '#b58863' },
	{ id: 'harbor', label: 'Harbor', light: '#dee3e6', dark: '#8ca2ad' },
	{ id: 'ash', label: 'Ash', light: '#e6e6e6', dark: '#9a9a9a' },
	{ id: 'orchid', label: 'Orchid', light: '#e9e2f3', dark: '#9b87c4' },
	{ id: 'ember', label: 'Ember', light: '#f6ddc6', dark: '#b97148' }
];

export const PIECE_SETS = [
	{ id: 'polished', label: 'Polished' },
	{ id: 'chessnut', label: 'Chessnut' },
	{ id: 'fantasy', label: 'Fantasy' }
];

const KEY = 'gameroom:chess-theme';
const DEFAULTS = { board: 'meadow', pieces: 'polished' };

function load() {
	if (typeof localStorage === 'undefined') return { ...DEFAULTS };
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
		return {
			// ignore stale ids so a removed theme can't leave the board unstyled
			board: BOARD_THEMES.some((t) => t.id === raw.board) ? raw.board : DEFAULTS.board,
			pieces: PIECE_SETS.some((p) => p.id === raw.pieces) ? raw.pieces : DEFAULTS.pieces
		};
	} catch {
		return { ...DEFAULTS };
	}
}

/**
 * Call once during component init. Returns the live selection plus the CSS
 * custom-property string to spread onto the board element.
 */
export function createChessTheme() {
	const initial = load();
	let board = $state(initial.board);
	let pieces = $state(initial.pieces);

	function persist() {
		try {
			localStorage.setItem(KEY, JSON.stringify({ board, pieces }));
		} catch {
			// private mode / quota — the choice just won't survive a reload
		}
	}

	return {
		get board() {
			return board;
		},
		get pieces() {
			return pieces;
		},
		get colors() {
			return BOARD_THEMES.find((t) => t.id === board) || BOARD_THEMES[0];
		},
		/** inline style for the board wrapper */
		get style() {
			const c = this.colors;
			return `--sq-l:${c.light}; --sq-d:${c.dark};`;
		},
		/** path to a piece svg, e.g. pieceSrc('w', 'K') */
		src(color, type) {
			return `/pieces/${pieces}/${color}${type.toUpperCase()}.svg`;
		},
		setBoard(id) {
			board = id;
			persist();
		},
		setPieces(id) {
			pieces = id;
			persist();
		}
	};
}

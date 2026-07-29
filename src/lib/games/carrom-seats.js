// Where each player sits, and which way their board faces.
//
// Every coordinate in carroms — the sim, the posted positions, the broadcast
// striker start — lives in ONE absolute board space, 0..1000 with the origin at
// the top-left. What differs per player is only how that space is rotated onto
// their screen, so their own edge is the one nearest their hands. This module is
// that mapping and nothing else: pure, no browser, no state, so the component
// renders through it and carrom-check.js can assert it.
//
// Sides are 0 = bottom, 1 = left, 2 = top, 3 = right, and seat i shoots from
// side i. Teams are seat parity (even = white, see carromTeamOf), so partners
// have to face each other: with four players that falls out of the numbering,
// and with two the second seat skips a side to land opposite the first. Carroms
// is 2-or-4 players only (initGame rejects anything else), so those are the only
// cases this has to answer for.

/** Baseline's distance from its own edge. */
export const BASE_OFF = 120;
/** Ends of a baseline, measured along its own axis. */
export const T_MIN = 150;
export const T_MAX = 1000 - 150;

/** Which edge does this seat shoot from? */
export function sideOfSeat(seat, playerCount) {
	if (seat < 0) return 0; // spectator — no seat, board stays unrotated
	return playerCount === 2 ? seat * 2 : seat;
}

/** Absolute board coords of a striker sitting `t` along `side`'s baseline. */
export function strikerPos(side, t) {
	const far = 1000 - BASE_OFF;
	if (side === 1) return { x: BASE_OFF, y: t };
	if (side === 2) return { x: t, y: BASE_OFF };
	if (side === 3) return { x: far, y: t };
	return { x: t, y: far };
}

/** Inverse of strikerPos' free axis: how far along `side` does `p` sit? */
export function alongSide(side, p) {
	return side === 1 || side === 3 ? p.y : p.x;
}

/** Keep a placement on its baseline between the two shooting circles. */
export function clampT(t) {
	return Math.max(T_MIN, Math.min(T_MAX, t));
}

/**
 * Rotation that brings `side` to the bottom of the screen. Feed it to
 * ctx.rotate() between a translate to the centre and back; toBoard() undoes it
 * for pointer input. Spectators pass side 0 and get no rotation.
 */
export function viewRotation(side) {
	return -(Math.PI / 2) * side;
}

/**
 * Screen point → absolute board coords, undoing viewRotation. The forward
 * transform the canvas applies is board → C + R(theta)·(p − C); this is its
 * exact inverse, so handlers can reason in the one space everything else uses.
 */
export function toBoard(x, y, theta) {
	const C = 500;
	const cos = Math.cos(-theta);
	const sin = Math.sin(-theta);
	const dx = x - C;
	const dy = y - C;
	return { x: C + dx * cos - dy * sin, y: C + dx * sin + dy * cos };
}

// $env-bound wrapper over ../shared/doflag.js, for SvelteKit routes. The DO and
// the generated worker wrapper import the shared module directly and pass the
// raw binding instead — see the note there.
import { env } from '$env/dynamic/private';
import { isDoRoom as pure } from '../shared/doflag.js';

/** @param {number|string} roomId */
export function isDoRoom(roomId) {
	return pure(roomId, env.DO_ROOMS);
}

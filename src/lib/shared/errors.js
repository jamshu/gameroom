// Isomorphic error helper. Lives in shared/ rather than server/ for one reason:
// gamelogic.js needs it, and gamelogic.js has to run inside the Durable Object —
// a bundle with no `$lib` alias and no `$env` virtual module. Importing it from
// server/room.js dragged in odoo.js → $env/dynamic/private, which is exactly the
// chain that made the game rules un-runnable outside a SvelteKit request.
//
// Nothing here may import anything that is not itself isomorphic.

/**
 * `code` is a stable machine-readable reason the client can branch on. A bare
 * 403 tells a client nothing — it can't distinguish "the host removed you"
 * (stop polling, go home) from a transient failure (keep trying).
 */
export function httpError(status, message, code) {
	const e = new Error(message);
	e.status = status;
	if (code) e.code = code;
	return e;
}

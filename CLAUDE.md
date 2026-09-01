# Gamerooms — project notes for agents

SvelteKit + Cloudflare Workers/Durable Objects game rooms. Most games are 2D and
turn-based/race; game logic lives in `src/lib/shared/*.js` (isomorphic, with a
`*-check.js` runnable test each), rooms/networking in `src/lib/do/` + `stores/room.js`.

## Hide & Fire (3D FPS game, Godot)

The `hidefire` game is a real-time 3D FPS: **Godot 4.7 web export** embedded in a
Svelte component, bundle hosted in **R2** (too big for Workers static assets), with a
non-obvious Godot⇄JS pull-bridge and a build→export→R2-upload→version-bump→deploy loop.

**Before doing any Godot / Hide & Fire work, read
[`godot/hidefire/README.md`](godot/hidefire/README.md)** — it has the toolchain, the
build/deploy loop, the bridge contract, solved gotchas, and the current
teams-vs-hide/seek WIP inconsistency to resolve.

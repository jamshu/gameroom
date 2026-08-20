# Hide & Fire — Godot source

The 3D arena for the `hidefire` game. Godot renders + simulates; the SvelteKit
host (`src/lib/components/HideFireArena.svelte`) owns the WebSocket and bridges
transforms in/out. See the split described in `src/lib/shared/hidefire.js`.

## Files
- `project.godot` — Godot 4.x project (GL Compatibility renderer, for WebGL2).
- `Main.tscn` / `Main.gd` — arena, world build, and the **only** JS bridge.
- `Player.gd` — local FPS controller: move/look/jump/crouch, hitscan fire, camo.
- `Puppet.gd` — remote players, driven by relayed `move` frames.

Input actions and all geometry are built in code (`Main._ensure_input`,
`_build_arena`), so there are no binary scenes/materials to hand-edit.

## Bridge contract (must match HideFireArena.svelte)
Godot → JS: `window.hidefireOnReady()`, `.hidefireOnTick(json)`, `.hidefireOnHit(uid)`
JS → Godot: `window.hidefirePushPeers(json)`, `.hidefireSetRound(json)`

`onTick` payload = `Player.get_net_state()`:
`{ pos:[x,y,z], yaw, pitch, camo:"rrggbb", still, alive }` (the host adds `uid`).
`setRound` = `{ role, endsAt, alive, result }`.

## Build / export (requires the Godot toolchain — not installed in CI)
1. Install **Godot 4.3+** and its **Web export templates**
   (Editor → Manage Export Templates → Download).
2. Open this folder as a project, then Project → Export → Add… → **Web**.
3. **Single-threaded**: in the Web preset, leave *Thread Support* **off**. This
   avoids `SharedArrayBuffer`, so the app does NOT need cross-origin isolation
   (COOP/COEP) headers from the Cloudflare Worker.
4. Set the export path so the files land as **`hidefire.*`**:
   `../../static/godot/hidefire/hidefire.html`
   Export produces `hidefire.html`, `hidefire.js`, `hidefire.wasm`, `hidefire.pck`
   (+ a small loader). The component loads `hidefire.js` and passes
   `executable: ".../hidefire"`, `mainPack: ".../hidefire.pck"`.
5. Commit `static/godot/hidefire/` (it's a build artifact, not built by Vite, and
   is excluded from the service-worker precache — see `vite.config.js` globIgnores).

Until step 5 exists, the room shows an "engine not built yet" overlay instead of
crashing (`HideFireArena` HEAD-probes `hidefire.js` first).

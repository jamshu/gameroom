# Hide & Fire — Godot + integration handoff

Everything a fresh agent needs to resume the **`hidefire`** game (Godot 4.7 web
export embedded in this SvelteKit / Cloudflare app). Read this before touching
Godot or Hide & Fire code.

---

## 1. What it is

A real-time 3D FPS game inside Gamerooms. **Godot 4 renders + simulates** (WASM
canvas); the **Svelte host** (`src/lib/components/HideFireArena.svelte`) owns the
network socket and bridges to Godot.

- **Solo** (offline, no login/DO): `/solo/hidefire` — practice vs an AI bot. This
  is the fastest way to test; it runs in plain `npm run dev`.
- **Multiplayer**: pick "🔫 Hide & Fire" in a room. Needs the **deployed Worker**
  (the Durable Object relays player positions) — it does NOT work in `vite dev`.

---

## 2. ⚠️ CURRENT STATE — mid-pivot, INCONSISTENT (read first)

The game is being pivoted from **hide/seek** (1 hider + 1 seeker, camo + 90s) to
**team deathmatch** (teams A/B, last team standing). The working tree is
**uncommitted and the two sides currently disagree** — the game is effectively
broken until this is reconciled:

- **Already converted to TEAMS:**
  - `src/lib/shared/hidefire.js` — `teams` A/B, `assignTeams`, `applyHit(game,
    victim, shooter)` with a friendly-fire block, `resolve` → `'A'|'B'|'draw'`,
    `ROUND_MS = 180000`, `nextRound` keeps teams.
  - `src/lib/games.js` — `needs: '2 to 8 players'`, `playerCapacity('hidefire') = 8`.
- **Still hide/seek (STALE — must be reconciled OR reverted):**
  - `src/routes/api/rooms/[id]/hidefire/hit/+server.js` — calls `applyHit(game,
    victim)` WITHOUT the `shooter` arg (so friendly-fire isn't enforced) and its
    comments still say "90s / hiders".
  - `src/lib/components/HideFireArena.svelte` — reads `g.roles` (now undefined),
    renders "🫥 Hide / 🔫 Seek" and "Seekers win"; `result` is now `A|B|draw`.
  - **All Godot scripts** — `SPAWNS { hider, seeker }`, `can_camo`, paint/pose,
    role-based spawns (`Main.gd`, `Player.gd`, `Bot.gd`).

**Decision for the next agent:** either finish the teams pivot across the endpoint
+ component + Godot (team spawns/colors, drop camo/pose or keep as flavor, send
`team` instead of `role`, pass `shooter` to `applyHit`, map `result` A/B/draw to
win text), **or** `git checkout` `hidefire.js` + `games.js` back to the last
committed hide/seek version. `git log --oneline` shows the shipped hide/seek
commits (`feat(hidefire): …`).

---

## 3. Architecture — two data planes (stable, keep)

Godot can't reach the room WebSocket directly, so the Svelte host owns it and
bridges to Godot.

- **FAST / ephemeral (~15 Hz)** — each player's position/yaw/pitch/camo/alive.
  Relayed peer-to-peer through the Durable Object via a `move` frame, **never
  persisted** (mirrors the carroms `aim` cursor). Touch points:
  `src/lib/do/frames.js` (`moveFrame`), `src/lib/do/room-do.js` (relay),
  `src/lib/stores/room.js` (`onMove` + `NO_ECHO_POLL`), `src/lib/server/realtime.js`
  (`publishMove`), endpoint `api/rooms/[id]/hidefire/move`.
- **SLOW / persisted** — round state (teams/alive/scores/result/timer) via
  `src/lib/shared/hidefire.js` + `gamelogic.js` (`initGame`) + endpoints
  `hidefire/hit` and `hidefire/next` + the existing room state machinery.
- **Hits are client-authoritative**: the shooter's Godot raycast decides, posts
  `hidefire/hit`. `// ponytail: add a server position check only if cheating matters.`

---

## 4. The Godot ⇄ JS bridge (critical, non-obvious)

- **Godot → JS works** by calling `window.*` methods directly.
- **JS → Godot does NOT** use `JavaScriptBridge.create_callback` (its proxies get
  garbage-collected in the web export and the call silently no-ops) and NOT
  `JavaScriptBridge.eval` (no-ops in the single-threaded export). Instead it's a
  **PULL model**: the JS host defines plain functions that Godot **calls every
  frame** and reads the return value of (`Main.gd → _poll_inbound`).

Contract (keep both sides in sync):

| Direction | Names |
|-----------|-------|
| Godot → JS (call) | `hidefireOnReady()`, `hidefireOnTick(json)`, `hidefireOnHit(uid)`, `hidefireOnDeath()` |
| JS → Godot (Godot pulls) | `hidefireDrain()` → JSON array of peer states; `hidefireRoundJson()` → round JSON; `hidefireTouchJson()` → touch input JSON |

The host queues into `window.__hidefireInbox` (peers), `window.__hidefireRound`
(round), `window.__hidefireTouch` (touch). Payloads:
- tick / peer: `{ uid, pos:[x,y,z], yaw, pitch, camo:"rrggbb", still, alive }`
- round: `{ role|team, you, endsAt, alive, result, solo, bot }`
- touch: `{ mx, my, crouch, lookdx, lookdy, fire, paint, pose, jump }`

---

## 5. Godot binary usage — the build / deploy loop (operational core)

**Toolchain (already installed on this machine):**
- Editor + binary: `/Applications/Godot.app/Contents/MacOS/Godot` (v4.7.2.stable).
- Web export templates at
  `~/Library/Application Support/Godot/export_templates/4.7.2.stable/`
  (`web_nothreads_release.zip` etc). If missing on another machine: download the
  official `Godot_v<ver>-stable_export_templates.tpz`, unzip, and copy the `web*`
  files + `version.txt` into that folder.

**Export preset** (`export_presets.cfg`, preset "Web"): single-threaded
(`variant/thread_support=false` → no SharedArrayBuffer → no COOP/COEP headers),
`html/canvas_resize_policy=1`, `export_path="build/web/hidefire.html"`.

**Edit → ship loop:**

1. **Export** (headless; use the ABSOLUTE path — a wrong cwd silently exports the
   wrong project):
   ```
   /Applications/Godot.app/Contents/MacOS/Godot --headless \
     --path /Users/jamshid/src/gamerooms/godot/hidefire --export-release "Web"
   ```
   Output → `godot/hidefire/build/web/` (gitignored). GDScript changes only change
   `hidefire.pck`; `hidefire.wasm` (~38 MB) changes only if the templates change.

2. **Upload to R2 — MUST use `--remote`** (without it, the object goes to the local
   miniflare store and production 404s — this bug actually happened and looked like
   "the bucket is empty"):
   ```
   npx wrangler r2 object put gameroom-assets/hidefire/hidefire.pck \
     --file godot/hidefire/build/web/hidefire.pck \
     --content-type application/octet-stream --remote
   ```
   Re-upload `hidefire.wasm` (and the audio worklets / `.js`) the same way only when
   they change (template/renderer change).

3. **Bump the cache version.** In `HideFireArena.svelte`, `ENGINE_VERSION`
   (currently `'v6'`) → bump on any prod re-export. The bundle is served with
   `immutable` cache, so the version segment in the URL path is what forces browsers
   to re-fetch. (Dev uses `dev-${Date.now()}`, always fresh.)

4. `npm run deploy`. Smoke-test:
   `curl -s -o /dev/null -w "%{http_code}\n" https://game.deedapp.net/godot/hidefire/v6/hidefire.pck`

---

## 6. Why it's not a Workers static asset (R2)

The ~38 MB `hidefire.wasm` exceeds the **25 MiB Workers per-asset cap**. So the
whole export lives in the **R2 bucket `gameroom-assets` under `hidefire/`** and is
streamed **same-origin** through `src/routes/godot/hidefire/[...file]/+server.js`
(reads the `GODOT_R2` binding in prod/`wrangler dev`; falls back to reading
`godot/hidefire/build/web/` off disk in `vite dev`). The catch-all route ignores a
leading version segment (`/godot/hidefire/<ver>/<file>`). In the Cloudflare
dashboard the files are inside the `hidefire/` "folder" (prefix), not the bucket root.

---

## 7. File map

**Godot source** (`godot/hidefire/`):
`project.godot`, `Main.tscn`, `Main.gd` (arena + the only JS bridge + FX),
`Player.gd` (local FPS controller), `Puppet.gd` (remote players), `Bot.gd` (solo
AI), `CharacterMesh.gd` (shared humanoid mesh), `export_presets.cfg`.
Gitignored: `.godot/`, `build/`, and a stray blank `hide-fire/` subproject the
editor created by accident (safe to delete).

**JS / Svelte:** component `src/lib/components/HideFireArena.svelte`; shared
`src/lib/shared/hidefire.js` (+ `hidefire-check.js`, `npm run check:hidefire`);
`gamelogic.js` (`initGame`), `games.js`, `do/frames.js`, `do/room-do.js`,
`stores/room.js`, `server/realtime.js`; endpoints
`api/rooms/[id]/hidefire/{move,hit,next}`; asset route
`routes/godot/hidefire/[...file]`; solo page `routes/solo/hidefire`; config
`wrangler.toml` (`GODOT_R2`, `run_worker_first` incl. `/godot/hidefire/*`),
`vite.config.js` (`globIgnores` `**/godot/**`).

---

## 8. Gotchas already solved (don't re-hit)

- Canvas needs an `id` — Emscripten builds the WebGL context selector as `#<id>`;
  no id ⇒ invalid selector `#` ⇒ crash.
- `canvasResizePolicy: 1` in the Engine config. Default (Adaptive) sizes the buffer
  to the whole window and letterboxes → black on mobile / half-screen on desktop.
- `camera.keep_aspect = KEEP_HEIGHT` + a raised gun, else the viewmodel crops off
  the bottom on the smaller (non-fullscreen) stage.
- Fullscreen is a **CSS-expand** (fixed cover of the viewport) + best-effort native
  FS; native-only failed on iOS and half-filled on desktop.
- Single-threaded export → no COOP/COEP headers needed.
- FX use **`CPUParticles3D`** (not GPU) so they render in the GL-compatibility
  renderer. Kill = blood + explosion; the win overlay is delayed ~1.2 s so the FX
  are visible first.
- Desktop fire **cursor-aims before pointer lock** (`camera.project_ray_*(event.
  position)`), then center-crosshair once locked — otherwise clicks miss.
- Keyboard (E paint / F pose) only reaches Godot once the canvas has focus — the
  player must click the canvas first (which also captures the mouse).

---

## 9. Run / verify

- **Solo (best, offline):** `npm run dev` → `/solo/hidefire`. Click the canvas to
  capture the mouse; WASD + mouse (or the on-screen touch controls on mobile);
  E paint, F pose, click/🔥 fire, ⛶ fullscreen.
- **Render test (inject a peer):** in the browser console —
  `window.__hidefireInbox.push(JSON.stringify({uid:2,pos:[-9,1,-9],yaw:0.8,camo:"ff2200",alive:true}))`
  (Godot pulls it and spawns/updates a puppet).
- **Multiplayer:** `npm run deploy`, then two browsers in one Hide & Fire room (the
  DO relay only exists on the deployed Worker).
- **Logic:** `npm run check:hidefire` covers the shared round rules.

---

## 10. Open issues

- **Teams/roles pivot inconsistency** — see §2; resolve first, the game is broken
  until then.
- Idle-player drift (the local player slowly slides from spawn when untouched).
- Multiplayer never verified end-to-end with two real clients.
- Gun framing on the small (non-fullscreen) stage; look-sensitivity tuning.
- `check:hidefire` — update it if you keep the teams model (it tests round logic).

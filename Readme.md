# Gamerooms

Play **chess**, **carroms**, and **thief-finder** with friends — live WebRTC voice
in every room, plus chat that carries text, photos and recorded voice messages.
Odoo backend (Studio-style manual models), SvelteKit SPA frontend, hosted on
Cloudflare Workers.

## Stack

- **Backend**: Odoo 17+ — three manual models (`x_gameroom`, `x_room_member`,
  `x_room_event`) created by `scripts/setup-odoo.js`. No custom addon.
- **Frontend**: SvelteKit (`ssr=false` SPA shell) + `/api/*` server routes
  (session-cookie proxy). The browser never talks to Odoo directly.
- **Realtime**: 2s polling through `/api/rooms/[id]/poll` (chat, presence, game
  state, WebRTC signaling). Voice is P2P mesh (cap 8), STUN only.
- **Chat media**: photos and voice clips are stored as `ir.attachment` rows tagged
  `res_model='x_gameroom'` / `res_id=<room>` (bytes in the `raw` field — `datas`
  does not exist on Odoo 19 and writing it stores nothing). The chat event carries
  only the attachment id; `/api/rooms/[id]/media/[attId]` serves the bytes and
  refuses any id not tagged with that room. `deleteRoom` unlinks them, so media
  dies when the last member leaves or the abandoned-room sweep fires.
- **Security model**: players have real Odoo logins but are adversaries — their
  Odoo access is read-only; every write goes through the admin key after
  proxy-side checks; the secret-bearing state field is admin-group-only.

## Setup

1. `cp .env.example .env` and fill in your Odoo URL/db/admin credentials.
2. `npm install`
3. `npm run setup:odoo` — creates models, fields, access rights (idempotent).
4. `npm run dev`

## Deploy (Cloudflare Workers)

```sh
npx wrangler login                  # once
npx wrangler secret put ODOO_URL    # repeat per secret, see below
npm run deploy                      # build + wrangler deploy
```

Secrets live in Cloudflare, never in the repo or the build artifact — unlike the
previous Amplify setup, which baked them into the deployed bundle.

**Required:** `ODOO_URL` `ODOO_DB` `ODOO_USERNAME` `ODOO_API_KEY` `CRON_SECRET`
**Optional:** `ABLY_API_KEY` `CF_TURN_KEY_ID` `CF_TURN_API_TOKEN` `VAPID_SUBJECT`
`VAPID_PRIVATE_KEY` `VAPID_PUBLIC_KEY` `PUBLIC_VAPID_PUBLIC_KEY` `METRICS_SINK`

`PUBLIC_VAPID_PUBLIC_KEY` is needed in **two** places — as a Worker secret (read
server-side via `$env/dynamic/public`) *and* in the build environment, because it
is baked into the prerendered shell at build time.

Two settings in `wrangler.toml` are load-bearing and easy to lose:
`assets.not_found_handling = "single-page-application"` (without it every hard
refresh of `/room/123` 404s) and `compatibility_flags = ["nodejs_compat"]`
(SvelteKit itself imports `node:async_hooks`).

Logs: `npm run cf:tail`. Local Workers runtime: `npm run cf:dev`.

**If the build fails with `EBUSY: resource busy or locked, rmdir '.svelte-kit/cloudflare'`** —
`scripts/clean-cf.mjs` (a `build` prestep) retries around this, so it should be
rare. If it persists, something is genuinely holding the directory: a
`wrangler dev` / `workerd` still running (`Get-Process node,workerd`), or a
terminal or file explorer sitting inside it.

## Checks

- `npm run check:all` — every assert suite below in one go
- `npm run check:push` — web-push crypto against the RFC 8291 published vector
- `npm run check:sim` — carrom physics self-check
- `npm run check:room` — seating/round helpers + chat-media ownership & cleanup
- `npm run test:e2e` — Playwright specs (fully mocked; no Odoo needed)
- `npx wrangler deploy --dry-run` — validates the Worker bundle without deploying

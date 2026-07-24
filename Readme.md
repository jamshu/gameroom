# Gamerooms

Play **chess**, **carroms**, and **thief-finder** with friends — live WebRTC voice
in every room, plus chat that carries text, photos and recorded voice messages.
Odoo backend (Studio-style manual models), SvelteKit SPA frontend, hosted on AWS
Amplify.

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

## Deploy (AWS Amplify)

Push to a Git remote, connect the repo in the Amplify console as a **Web Compute
(SSR)** app with build output directory `build`. Set the `.env` vars in the
Amplify console — `amplify.yml` bakes them into the compute bundle at build time
(`scripts/bake-amplify-env.mjs`). Enable SSR app logs for CloudWatch debugging.

## Checks

- `npm run check:sim` — carrom physics self-check
- `npm run check:room` — seating/round helpers + chat-media ownership & cleanup
- `npm run test:e2e` — Playwright specs (fully mocked; no Odoo needed)
- `npm run build` — must produce `build/compute/default/` + `build/deploy-manifest.json`

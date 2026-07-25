# Thief Finder role faces

One image per role, replacing that role's emoji everywhere the game shows it —
your secret card, the envelope you opened, the police banner, the verdict
sentence and the reveal grid.

Nothing in here is bundled by default. The directory ships empty on purpose:
`ROLE_ART` in `src/lib/roles.js` already points at `police.png` and `thief.png`,
and any role whose file is missing quietly falls back to its emoji. So the set
can be filled in one face at a time with nothing ever rendering broken.

| File | Role | Source | Licence |
|---|---|---|---|
| _(none yet)_ | | | |

## Adding a face

1. Drop a landscape PNG at `static/roles/<role>.png`, lowercase, matching a role
   name from `ROLE_LADDER` in `src/lib/server/gamelogic.js` (or `police` /
   `thief`). Roughly 4:3 through 3:2 crops best — the art is rendered with
   `object-fit: cover` at sizes from 30×21 up to 96×64, so keep the face
   centred and don't rely on detail near the edges.
2. Add the entry to `ROLE_ART` in `src/lib/roles.js` if it isn't already there.
3. Record its source and licence in the table above.
4. Rebuild — the service worker precache manifest is globbed from build output
   (`vite.config.js`), so a face added after a build isn't available offline
   until the next one. PNG is required for the same reason: the glob covers
   `png` but not `jpg` or `webp`.

## Provenance matters here

Film stills and screen-grabs of actors are copyrighted, and publicity or
personality rights can apply to a recognisable performer's likeness on top of
that. Whatever goes in this directory ships with the app, so treat it the way
`static/pieces/LICENSES.md` treats the chess sets: know the source, record it
above, and don't add anything whose terms you can't state — especially if this
repo ever goes public or the app is ever commercial.

## Which face on which role

Filenames are keyed by role, never by actor, so the mapping is entirely decided
by what you drop in. `police.png` and `thief.png` are the two that carry the
round; `king.png` is the third most-seen, because
`ROLE_LADDER.slice(0, players.length - 2)` means a 3-player room only ever deals
Thief, Police and King. `Barber` and `Cobbler` need 11–12 players to appear at
all.

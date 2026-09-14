# Game discovery and quality design

## Goal

Make Gamerooms easier to choose and start, strengthen its child-friendly game
loop, and stabilize Hide & Fire before further FPS features.

## Scope

### Game metadata and discovery

Extend the existing `GAMES` registry with display-only metadata:

- category: `kids`, `puzzle`, `fast`, `team`, `strategy`, or `social`
- short description
- recommended age label
- estimated session duration
- kid-friendly flag

The home page and lobby read this single registry. No database model or new
dependency is introduced.

The home page gains category filters and richer game cards. Every card shows
the existing player requirement, a duration, and a one-line rules summary.

### Quick Play

Quick Play accepts a chosen game type. It attempts to join a public lobby with
an open compatible player seat. If none is available, it creates a fresh public
room with that game type and sends the caller to its lobby. The room uses the
existing name, visibility, membership, and join flows.

### Hangout

Keep the existing `videocall` id and behavior for backwards compatibility.
Rename its label to `Hangout`, update its description and social category, and
keep it available in the game picker.

### Compact in-game status

Add one reusable compact, collapsible status pill in room play. It shows the
current game's relevant score/progress and timer when available. It is hidden
by default on small screens and expands only on request, preserving board size.
It reuses the existing room state and does not introduce a second score source.

### Difficulty

Add `easy`, `normal`, and `hard` choices to room setup for Sudoku, Bird Sort,
Candy Match, and Memory Match. Each game gets a deterministic deal/configuration
from the chosen level. `normal` is the default and rooms created before this
change use it when no value is stored.

### Memory Match Race

Add a 2–6 player simultaneous race and matching solo route. All players receive
the same seeded card layout. Each player owns only their own revealed/matched
state. A turn flips cards locally; a non-pair is hidden after a short delay. The
first player to match all pairs wins. The server persists only the per-player
progress/finish state and validates the reported result against the deterministic
seed and move log where practical; it never trusts a client-provided winner.

The game follows the existing race-game pattern: pure isomorphic shared logic,
a runnable Node self-check, a solo page, room component, Durable Object write
operation, state view projection, result scoring, and Playwright room smoke
coverage.

### Hide & Fire quality gate

Do not add more Hide & Fire effects or mechanics in this release. Add a
two-client smoke/regression check for:

1. team A and B spawn inside bounds;
2. a hit removes the victim from play;
3. next round revives, relocates, and unfreezes every player;
4. each client sees the other moving after the new round.

The check should validate the JavaScript state machine directly and use the
existing Godot local render hook for visual/manual verification. It should not
attempt a full browser WebGL multiplayer test in CI until a stable deployed test
environment exists.

## Compatibility and error handling

- Existing rooms fall back to `normal` difficulty.
- `videocall` remains the stored game id; only the human-facing label changes.
- Quick Play treats a full/pending/failed join as unavailable and creates a room
  rather than surfacing a dead end.
- Race writes remain owned by the Durable Object to avoid Odoo write contention.
- The shared game registry remains the only definition of player capacity and
  display metadata.

## Verification

- Extend `games-check.js` for metadata and renamed Hangout.
- Add a Memory Match shared-logic check and include it in `check:all`.
- Add race-game and Quick Play mocked Playwright coverage.
- Add Hide & Fire round-transition assertions to `hidefire-check.js`.
- Run `npm run check:all`, `npm run test:e2e`, and `npm run build`.

## Delivery order

1. Metadata, Hangout rename, filters, and Quick Play.
2. Difficulty plumbing and compact status pill.
3. Memory Match Race and its checks.
4. Hide & Fire regression gate.


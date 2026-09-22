# Game Discovery and Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make games easier to choose and start, add configurable kid-friendly race difficulty and Memory Match, and establish Hide & Fire regression coverage.

**Architecture:** Extend the existing `GAMES` registry with display metadata and reuse it in dashboard and lobby UI. Persist normalised `settings` in the existing room state envelope, so absent settings remain compatible. Memory Match follows the existing race-game Durable Object pattern: each player submits only verified matching pairs.

**Tech Stack:** Svelte 5/SvelteKit, Cloudflare Workers and Durable Objects, Odoo room records, Node assert checks, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-game-discovery-and-quality-design.md`

## Global Constraints

- Do not add dependencies or an Odoo field/model.
- `videocall` remains the stored game id; its display label becomes Hangout.
- Missing `state.settings` means `{ difficulty: 'normal' }`.
- Keep `shared/` and `do/` free of `$lib` and `$env` imports.
- Quick Play creates a public room when no followed host has a compatible public lobby.
- Race mutations stay in Durable Object `raceWrite` operations.
- Do not add Hide & Fire mechanics; test its round state instead.

---

## File map

- `src/lib/games.js` — game metadata, categories, difficulty helpers, capacities.
- `src/routes/+page.svelte` — filters, rich cards, Quick Play control.
- `src/routes/api/rooms/+server.js` — validate/create persisted settings.
- `src/routes/api/rooms/quick-play/+server.js` — followed-lobby join or public-room fallback.
- `src/routes/api/rooms/[id]/game-type/+server.js` and `start/+server.js` — update/use selected settings.
- `src/lib/shared/gamelogic.js` — game initialisation, memory arbiter, client views/scoring.
- `src/lib/components/RoomLobby.svelte`, `GameStatus.svelte`, and room page — lobby detail, difficulty selector, status pill.
- `src/lib/shared/memory.js`, `memory-check.js`, `MemoryBoard.svelte`, `MemoryRace.svelte`, solo page, endpoint and DO op — Memory Match.
- `src/lib/shared/hidefire-check.js`, `godot/hidefire/README.md`, `Readme.md` — regression gate and accurate documentation.
- `tests/game-discovery.spec.js`, `tests/race-games.spec.js`, `tests/solo-games.spec.js` — browser coverage.

### Task 1: Registry metadata, Hangout rename, and settings contract

**Files:**
- Modify: `src/lib/games.js`
- Modify: `src/lib/games-check.js`
- Modify: `src/lib/shared/gamelogic.js`

**Interfaces:**
- Produces `GAME_CATEGORIES`, `GAME_DIFFICULTIES`, and `gameDifficulty(gameType, value)`.
- Adds metadata to every game: `category`, `description`, `age`, `minutes`, `kidFriendly`.
- Extends `initGame(gameType, playerUids, room, settings = {})` and `stateView(...).settings`.

- [ ] **Step 1: Write failing registry assertions**

```js
assert.equal(gameById('videocall').label, 'Hangout');
assert.equal(gameById('birdsort').category, 'kids');
assert.equal(gameDifficulty('sudoku', 'bad'), 'normal');
assert.equal(gameDifficulty('chess', 'hard'), 'normal');
```

- [ ] **Step 2: Run the check**

Run: `npm run check:games`

Expected: FAIL because game metadata and `gameDifficulty` do not exist.

- [ ] **Step 3: Add the minimum registry contract**

```js
export const GAME_CATEGORIES = ['kids', 'puzzle', 'fast', 'team', 'strategy', 'social'];
export const GAME_DIFFICULTIES = ['easy', 'normal', 'hard'];
export const gameDifficulty = (gameType, value) =>
  gameById(gameType).difficulty && GAME_DIFFICULTIES.includes(value) ? value : 'normal';

{ id: 'videocall', label: 'Hangout', emoji: '📹', needs: '2 to 6 players',
  category: 'social', description: 'Video chat and spend time together.',
  age: 'All ages', minutes: 'Open-ended', kidFriendly: true }
```

Give every entry the listed display fields. Mark only Sudoku, Candy Match, Bird Sort, and Memory Match with `difficulty: true`.

- [ ] **Step 4: Add settings to the state projection**

```js
settings: state.settings || { difficulty: 'normal' },
game: gameView(state.game, uid)
```

Use the optional fourth init argument internally; preserve all existing three-argument calls.

- [ ] **Step 5: Verify**

Run: `npm run check:games && npm run check:noenv`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/games.js src/lib/games-check.js src/lib/shared/gamelogic.js
git commit -m "feat: add game discovery metadata"
```

### Task 2: Persist difficulty and configure existing race games

**Files:**
- Modify: `src/routes/api/rooms/+server.js`
- Modify: `src/routes/api/rooms/[id]/game-type/+server.js`
- Modify: `src/routes/api/rooms/[id]/start/+server.js`
- Modify: `src/lib/shared/gamelogic.js`
- Modify: `src/lib/shared/sudoku-check.js`
- Modify: `src/lib/shared/birdsort-check.js`
- Modify: `src/lib/shared/match3-check.js`

**Interfaces:**
- Create/game-type bodies consume `difficulty`.
- State owns `settings: { difficulty }`.
- Race game objects expose their normalised `difficulty`.

- [ ] **Step 1: Add failing difficulty assertions**

```js
assert.equal(initGame('sudoku', [1, 2], {}, { difficulty: 'easy' }).difficulty, 'easy');
assert.equal(initGame('birdsort', [1, 2], {}, { difficulty: 'hard' }).difficulty, 'hard');
assert.equal(initGame('match3', [1, 2], {}, { difficulty: 'easy' }).durationMs, 120_000);
```

- [ ] **Step 2: Run focused checks**

Run: `npm run check:sudoku && npm run check:birdsort && npm run check:match3`

Expected: FAIL because room games are currently fixed.

- [ ] **Step 3: Persist normalised settings**

```js
const difficulty = gameDifficulty(gameType, body.difficulty);
const state = { v: 0, voice: [], game: null, settings: { difficulty } };
// start:
state.game = initGame(room.x_studio_game_type, playerUids, room, state.settings);
```

On game type switching, replace only `state.settings.difficulty` with the normalised setting for the selected game. Existing rooms default to normal.

- [ ] **Step 4: Add explicit difficulty behaviour**

```js
const SUDOKU_LEVEL = { easy: 'easy', normal: 'medium', hard: 'hard' };
const MATCH3_DURATION = { easy: 120_000, normal: 90_000, hard: 60_000 };
```

For Bird Sort, retain the current board dimensions. Add `genTubes(seed, difficulty)`: easy uses a deterministic small legal scramble, normal uses the existing validated shuffle, hard rejects deals with fewer than two mixed tubes beyond normal's first accepted candidate.

- [ ] **Step 5: Verify**

Run: `npm run check:sudoku && npm run check:birdsort && npm run check:match3 && npm run check:games`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/rooms/+server.js src/routes/api/rooms/'[id]'/game-type/+server.js src/routes/api/rooms/'[id]'/start/+server.js src/lib/shared/gamelogic.js src/lib/shared/sudoku-check.js src/lib/shared/birdsort-check.js src/lib/shared/match3-check.js
git commit -m "feat: add room race difficulties"
```

### Task 3: Dashboard discovery and Quick Play

**Files:**
- Modify: `src/routes/+page.svelte`
- Create: `src/routes/api/rooms/quick-play/+server.js`
- Modify: `src/routes/api/rooms/+server.js`
- Create: `tests/game-discovery.spec.js`

**Interfaces:**
- `POST /api/rooms/quick-play` consumes `{ gameType }` and returns `{ ok, roomId, created }`.
- Dashboard owns `selectedCategory` and `quickGame`.

- [ ] **Step 1: Write failing browser coverage**

```js
await page.route('**/api/rooms/quick-play', (route) =>
  route.fulfill({ json: { ok: true, roomId: 77, created: true } })
);
await page.goto('/');
await page.getByRole('button', { name: 'Kids' }).click();
await expect(page.getByText('Bird Sort')).toBeVisible();
await page.getByRole('button', { name: 'Play now' }).click();
await expect(page).toHaveURL('/room/77');
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/game-discovery.spec.js`

Expected: FAIL because the controls and endpoint are absent.

- [ ] **Step 3: Implement followed-host-first Quick Play**

Extract one local helper from the normal create route:

```js
async function createRoomForUser({ uid, name, gameType, visibility, allowedUids = [], settings = {} })
```

It creates the room and the caller's accepted player row and returns `roomId`. Call it from the normal create route and Quick Play route. Quick Play reads the caller's `x_studio_following_ids`, queries newest public lobbies with matching game type and a followed host, reads candidate members, and chooses one with an open `playerCapacity` seat. If none qualifies, call `createRoomForUser` with `name: 'Quick ' + gameById(gameType).label`, `visibility: 'public'`, and normal settings.

- [ ] **Step 4: Implement metadata cards and filters**

```js
const visibleGames = $derived(GAMES.filter((g) =>
  selectedCategory === 'all' || g.category === selectedCategory ||
  (selectedCategory === 'kids' && g.kidFriendly)
));
```

Show description, existing `needs`, age and duration. Retain the current accessible radio group for create-room selection.

- [ ] **Step 5: Verify**

Run: `npx playwright test tests/game-discovery.spec.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/+page.svelte src/routes/api/rooms/+server.js src/routes/api/rooms/quick-play/+server.js tests/game-discovery.spec.js
git commit -m "feat: add game discovery and quick play"
```

### Task 4: Lobby detail, difficulty selector, and status pill

**Files:**
- Modify: `src/lib/components/RoomLobby.svelte`
- Create: `src/lib/components/GameStatus.svelte`
- Modify: `src/routes/room/[id]/+page.svelte`
- Modify: `tests/game-discovery.spec.js`

**Interfaces:**
- `GameStatus` receives `{ game, members, myUid, wins }`.
- `RoomLobby` posts `{ gameType, drawsTotal, difficulty }`.

- [ ] **Step 1: Add failing UI assertions**

```js
await expect(page.getByText('Race to sort birds into matching branches.')).toBeVisible();
await expect(page.getByLabel('Difficulty')).toHaveValue('normal');
await expect(page.getByRole('button', { name: /Game status/ })).toBeVisible();
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/game-discovery.spec.js`

Expected: FAIL.

- [ ] **Step 3: Implement the smallest status UI**

```svelte
<details class="game-status">
  <summary aria-label="Game status">⌄ Status</summary>
  <span>{label}</span>
</details>
```

Derive its label solely from current state: race timer from `startedAt + durationMs`, Hide & Fire survivor counts from `alive`, and cumulative room wins from `wins`. Do not add a second score store or a poll loop.

- [ ] **Step 4: Add lobby copy and difficulty select**

Show `gameById(room.gameType).description` and `needs`. Render `<select aria-label="Difficulty">` only for `gameById(pick).difficulty`; bind normal when state has no setting.

- [ ] **Step 5: Verify and commit**

Run: `npx playwright test tests/game-discovery.spec.js`

Expected: PASS.

```bash
git add src/lib/components/RoomLobby.svelte src/lib/components/GameStatus.svelte src/routes/room/'[id]'/+page.svelte tests/game-discovery.spec.js
git commit -m "feat: show game details and compact status"
```

### Task 5: Deterministic Memory Match server rules

**Files:**
- Create: `src/lib/shared/memory.js`
- Create: `src/lib/shared/memory-check.js`
- Modify: `src/lib/shared/gamelogic.js`
- Modify: `src/lib/games.js`
- Modify: `src/lib/do/room-do.js`
- Create: `src/routes/api/rooms/[id]/memory/match/+server.js`
- Modify: `package.json`

**Interfaces:**
- `memoryDeck(seed, difficulty)` returns deterministic card ids.
- `initMemory(players, settings)` returns a race game state.
- `applyMemoryMatch(game, uid, first, second)` returns `{ ok, matched, finished, pairs }`.
- DO op: `memoryMatch`.

- [ ] **Step 1: Write the shared-rules check**

```js
const deck = memoryDeck('same', 'normal');
assert.deepEqual(deck, memoryDeck('same', 'normal'));
assert.equal(deck.length, 16);
const g = initMemory([1, 2], { difficulty: 'easy' });
assert.equal(applyMemoryMatch(g, 1, 0, 1).ok, false);
```

Find a real matching pair in the deck for the success assertion; assert already-matched indices and foreign user data are refused.

- [ ] **Step 2: Run it**

Run: `node src/lib/shared/memory-check.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic deck and verified pairs**

```js
const PAIRS = { easy: 6, normal: 8, hard: 10 };
export function memoryDeck(seed, difficulty = 'normal') {
  return shuffle(makeRng(seed), Array.from({ length: PAIRS[difficulty] }, (_, i) => [i, i]).flat());
}
export function applyMemoryMatch(game, uid, first, second) {
  if (!Number.isInteger(first) || first === second || game.deck[first] !== game.deck[second]) {
    return { ok: false, status: 400, error: 'Not a matching pair' };
  }
}
```

Store only `boards[uid].matched` and `doneAt`; the UI owns temporary flipped non-pairs. Add `memoryView` that sends a player's indices only to them and rivals' pair count/progress only. Add `{ id: 'memory', label: 'Memory Match', emoji: '🃏', needs: '2 to 6 players', category: 'kids', difficulty: true }` to `GAMES`, return `playerCapacity('memory') === 6`, then add game init, winner, score, and client-view branches.

- [ ] **Step 4: Wire durable and HTTP mutation paths**

```js
case 'memoryMatch':
  return this.raceWrite('memory', (game) =>
    applyMemoryMatch(game, Number(op.uid), op.first, op.second)
  );
```

Add `memoryMatch` to `OWNING_OPS`. The HTTP route uses Bird Sort's DO-first/fallback/finishRoom shape and sends `{ first, second }`.

- [ ] **Step 5: Register and verify**

```json
"check:memory": "node src/lib/shared/memory-check.js"
```

Add it to `check:all`.

Run: `npm run check:memory && npm run check:noenv && npm run check:all`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shared/memory.js src/lib/shared/memory-check.js src/lib/shared/gamelogic.js src/lib/games.js src/lib/do/room-do.js src/routes/api/rooms/'[id]'/memory/match/+server.js package.json
git commit -m "feat: add memory match race rules"
```

### Task 6: Memory Match UI and solo play

**Files:**
- Create: `src/lib/components/MemoryBoard.svelte`
- Create: `src/lib/components/MemoryRace.svelte`
- Create: `src/routes/solo/memory/+page.svelte`
- Modify: `src/routes/room/[id]/+page.svelte`
- Modify: `src/routes/+page.svelte`
- Modify: `tests/race-games.spec.js`
- Modify: `tests/solo-games.spec.js`

**Interfaces:**
- `MemoryBoard` receives `{ deck, matched, disabled, rivals, onMatch }`.
- `MemoryRace` posts `memory/match` with two indices.

- [ ] **Step 1: Add failing room coverage**

```js
const game = initGame('memory', [100, 101], {}, { difficulty: 'easy' });
await mockRoom(page, 'memory', game);
await page.goto('/room/1');
await expect(page.locator('.memory-card')).toHaveCount(12);
```

Mock `memory/match` by applying the real shared arbiter and returning `stateView`.

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/race-games.spec.js`

Expected: FAIL.

- [ ] **Step 3: Implement transient local flips**

```js
async function choose(index) {
  if (locked || revealed.includes(index) || matched.includes(index)) return;
  revealed = [...revealed, index];
  if (revealed.length !== 2) return;
  const [first, second] = revealed;
  if (deck[first] !== deck[second]) { await delay(650); revealed = []; return; }
  await onMatch(first, second);
  revealed = [];
}
```

Respect reduced motion. Cards are buttons with `aria-label="Card N"`; server state remains the only match source of truth.

- [ ] **Step 4: Add multiplayer and solo wrappers**

MemoryRace derives rival pairs from projected game data. Solo creates `initMemory([0], { difficulty })`, applies pairs locally through the same arbiter, records duration in `solo-bests`, and supplies Easy/Normal/Hard controls. Add the room branch and solo dashboard card.

- [ ] **Step 5: Verify and commit**

Run: `npx playwright test tests/race-games.spec.js tests/solo-games.spec.js`

Expected: PASS.

```bash
git add src/lib/components/MemoryBoard.svelte src/lib/components/MemoryRace.svelte src/routes/solo/memory/+page.svelte src/routes/room/'[id]'/+page.svelte src/routes/+page.svelte tests/race-games.spec.js tests/solo-games.spec.js
git commit -m "feat: add memory match interfaces"
```

### Task 7: Hide & Fire regression gate and current documentation

**Files:**
- Modify: `src/lib/shared/hidefire-check.js`
- Modify: `godot/hidefire/README.md`
- Modify: `Readme.md`

**Interfaces:**
- `nextRound(game, now)` preserves teams/scores and restores every player to alive.
- A new `endsAt` is the Godot fresh-spawn signal.

- [ ] **Step 1: Add transition assertions**

```js
const g = initHideFire([1, 2, 3, 4], null, 0);
applyHit(g, 2, 1); applyHit(g, 4, 3); resolve(g, 10);
const next = nextRound(g, 1000);
assert.deepEqual(next.teams, g.teams);
assert.ok(Object.values(next.alive).every(Boolean));
assert.notEqual(next.endsAt, g.endsAt);
assert.equal(next.result, null);
```

Also assert team sizes differ by no more than one for odd counts and retain friendly-fire/dead-shooter coverage.

- [ ] **Step 2: Verify it**

Run: `npm run check:hidefire`

Expected: PASS.

- [ ] **Step 3: Replace stale docs**

Update the Godot README to describe team deathmatch, current bridge payload, cache-bust/export/R2/deploy sequence, and a two-client manual smoke test: both spawn inside bounds; kill one player; next round; verify both move and see one another. Update root README's game list and describe WebSocket/DO realtime with polling fallback.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shared/hidefire-check.js godot/hidefire/README.md Readme.md
git commit -m "test: document hidefire round regression gate"
```

### Task 8: Full verification

**Files:**
- Modify only files where a verification failure identifies a real defect.

- [ ] **Step 1: Run deterministic checks**

Run: `npm run check:all`

Expected: PASS.

- [ ] **Step 2: Run browser coverage**

Run: `npm run test:e2e`

Expected: PASS.

- [ ] **Step 3: Build the Worker**

Run: `npm run build`

Expected: Cloudflare adapter build completes with no Svelte compile errors.

- [ ] **Step 4: Record the verification result in the pull request or handoff**

Do not make a no-op commit. If a verification failure produces a repair, add that repair to the task that owns its file and commit with that task's conventional message.

## Plan self-review

- Tasks 1–4 cover game discovery, Hangout, Quick Play, status, and difficulty.
- Tasks 5–6 cover deterministic Memory Match with server-validated pairs.
- Task 7 covers the Hide & Fire quality gate and docs.
- Task 8 executes every check stated in the spec.
- Compatibility is explicit: `videocall` id is retained and absent settings normalise to normal.

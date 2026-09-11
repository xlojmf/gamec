# Handoff — resume here

**Project:** Catan 3D — unofficial fan re-implementation, TanStack Start + Three.js + boardgame.io.
**PRD:** [`PRD.md`](./PRD.md) (§5 = rules contract, §6 = milestones, §7 = multiplayer design). **Status tracker:** `src/data/milestones.ts` (keep in sync with PRD + README).

## Where we are

Coolify preparation: see `deploy.md` and `docker-compose.coolify.yml`. Website target is `https://game.jmfserver.uk`, API target `https://game-api.jmfserver.uk`. `VITE_GAME_SERVER_URL` is passed as a Docker build argument; the same HTTPS origin drives REST and Socket.IO. Local Compose explicitly passes its existing port configuration, and Docker excludes local `.env` files. No VPS deployment has been performed in this task.

M0–M13 and A1–A6 done, all green (typecheck ✅ · 120/120 tests ✅ · build ✅ · docker e2e ✅):

| Milestone | What |
|---|---|
| M0–M5 | scaffold, board, terrain, placement sandbox, camera, Docker |
| M6 | dice (3D throw, 7→robber mode) |
| M7 | resource production (hands, bank, pulses) |
| M8 | player turns (boardgame.io engine, hotseat) |
| M9 | building rules (costs, supply, connectivity, upgradeCity) |
| M10 | trading (bank/ports, domestic propose-accept) |
| M11 | dev cards & awards |
| M12 | **multiplayer** — bgio server (`game` compose service), `/online` lobby with 4-char room codes, hidden hands via `playerView`, sessionStorage reconnect |
| M13 | **rules refinements & resilience** — dev cards before the roll (official), hotseat 3–4P picker, full reveal on game over, win-only-on-your-turn, persisted rooms/matches (FlatFile + rooms.json in the `catan-data` volume), stall watchdog (auto-plays idle seats past `TURN_TIMEOUT_SECONDS`), creator rematch (fresh island, same room) |

Extras beyond the PRD checklist: visible harbor docks with trade-ratio signs + hover tooltips + sidebar legend; `mp.e2e.test.ts` plays a full 4-client setup draft over real websockets.

## Completed art track A1–A6

- Built-in imagegen concept hero; six terrain tops and six sides, water, walnut frame, ivory token material. Manifest slots are loaded in GameView with procedural fallbacks.
- Custom SVG crest, five resource icons and six exact dice faces; ivory HUD and teal/brass landing page; responsive camera and mobile sheet.
- Opt-in user-supplied MP3 sounds; placement drops; safe last-paid-build undo; full voyage journal; change-corner setup action.
- Multi-recipient offers and counter-offers. PendingTrade.partners is optional for old saves. First acceptance clears all response stages; a counter replaces the offer and changes the responder. The watchdog declines remaining recipients in sequence.
- Fixed pre-roll Road Building placement and finish flow; rolling is disabled while a development effect is unresolved. Added integer/resource validation for trade inputs.
- Browser smoke covered local placement, setup reselection and responsive layout. See docs/art/art-direction.md and the live /assets/astra/kit.html catalog.

### New engineering rules

pushLog invalidates G.lastBuild. Paid building moves capture the prior award holders, then store a fresh undo record after logging. onBegin clears the record. Do not expose undo for random, secret-revealing or multi-party moves. When testing Client.updatePlayerID, access client.moves again afterward: previously captured move functions retain the old player ID.

Post-v1 options: spectators, cross-tab session sharing and AI opponents.

## M12 architecture (how online play works)

- Rooms: creator picks **3 or 4 players** and is the only one who can **Start** (`POST /rooms/:code/start`, creator token in sessionStorage) — everyone seated auto-enters when started. The **opening-roll phase** (multiplayer only) makes every seat throw for turn order; highest places first (ties re-roll; snake draft + main phase both derive from `G.firstPlayer` via `G.setupPlacements`, NOT ctx.turn — turn numbers differ between hotseat and mp).
- **Player names**: `G.playerNames` (color defaults). Clients publish their room alias via the `setPlayerName` move on their first turn (bgio only lets the active player move); all engine logs go through `pname(G, p)`. UI reads `pname(G, i)`.
- **Dice animation follows every live roll** (game.tsx): the 3D throw fires for any roll nonce that appears *after* the first state sync — one player clicks, everyone's dice fly together (within broadcast latency). State replayed on connect/refresh is adopted silently (nonce-marked on first sync, `G`-null renders never mark); the HUD dice panel shows every roll either way. `rolling` is set by any triggered animation, not only own clicks.
- `src/server/gameServer.ts` → `dist/game/gameServer.js` (vite SSR build, `vite.game.config.ts`, boardgame.io bundled — its CJS/ESM dir imports can't be resolved by Node ESM at runtime; `node-persist` externalized but never loaded without `FLATFILE_DIR`). One port = ws transport + built-in lobby REST (`/games/*`) + custom rooms API (`POST /rooms`, `GET /rooms/:code`, `POST /rooms/:code/join`, `POST /rooms/:code/start`, `GET /health`). Rooms map 4-char codes → matchIDs, in memory.
- Client: `/online` (lobby + room seats) → `/game?match=<matchID>&seat=<n>`; credentials in `sessionStorage` (`catan-mp-<matchID>`, helpers in `src/multiplayer/session.ts`); `?server=host:port` overrides the default `${location.hostname}:8000`. Hotseat stays at plain `/game` (no search params).
- `CatanGame.playerView` masks other hands/devHands to counts (`handSizes`/`devHandSizes` extras) and flattens the deck; `createCatanGame(seed)` strips playerView for open-information hotseat.
- In `game.tsx`: `seat` (null in hotseat) → `actor`/`myTurn` gate every dispatch; hidden hands render as `N cards` chips; discard/trade-respond overlays only act for the owning seat; board seed comes from server state.

## boardgame.io 0.50 gotchas (learned the hard way — read before touching the engine)

- **Local `Client` does NOT forward `setupData`** → hotseat uses the `createCatanGame(seed)` factory. The server/multiplayer path DOES forward it.
- `INVALID_MOVE` is the **string** `'INVALID_MOVE'` from `boardgame.io/core` — not a Symbol.
- Triggers (`endIf`, phase `next`, order `first`/`next`) receive `{ G, ctx }`; **hooks (`onBegin` etc.) must return G** or state becomes undefined.
- Phase `endIf` is evaluated **at turn end** — a move must call `events.endTurn()` for it to fire.
- `events`/`random`/`playerID` are **separate move args** (`({ G, ctx, playerID }, ...args)`), not on `ctx`. The first arg is the FnContext — `({ G }) => { G.x }`, mutating the wrapper object silently does nothing.
- **Rejected moves still advance the seeded rng** — tests that roll "until 7" see different sequences depending on prior rejected dispatches.
- bgio state is immer-frozen → in tests `structuredClone(state.G)` before mutating (see `fakeG` / `mainG`).
- **The `seed` client option does NOT make the 0.50 local client's rng deterministic** — rolls are effectively Math.random-backed and a "guaranteed non-7" roll can still come up 7. Tests must tolerate surprise 7s: use `rollUntilProducing(client, seed)` (resolves discard/move/steal and re-rolls) instead of asserting on one roll. Consequence: **it may end turns internally** — always assert relative to the *actual* current player after calling it. For real determinism derive from `mulberry32(seed)` in setup (the dev deck does this via `makeDevDeck`).
- Main phase turn order is a custom `mainOrder` (CONTINUE-style) so player 0 — the last setup placer — takes the first turn.
- **Unit-testing moves without a client**: `CatanGame.phases.main.moves.X({ G, ctx }, args)` works on a `structuredClone`d G + plain ctx (see `mainG`/`ctx0` in `catan.test.ts`) — precise, deterministic, no rng drift. Stage moves live at `CatanGame.phases.main.turn.stages.<stage>.moves` (see `respondMoves`). Fake `random` via `{ Die: () => 1 }`.
- **`setActivePlayers({ value })` locks the current player out of ALL moves** until every stage player calls `events.endStage()` — used by the trade `respond` stage (and the `discard` stage) to block the turn while someone else must act.
- The installed bgio is fine, but writing ad-hoc node repros against `boardgame.io/dist/cjs/*` wastes time — the CJS chunks misbehave standalone; always go through vite/vitest (ESM) or the package subpath wrappers.

## Architecture rules (unchanged)

- `src/game/*` = pure, no framework imports, Maps allowed *outside* bgio state; **G stays JSON-serializable** (buildings are `Record`s, never Maps). Board is regenerated from `G.seed` via `boardFor()` (cached). Dev deck order is derived from the seed (`makeDevDeck`), never stored randomness beyond the array itself.
- Validators are the single source of truth for legality (moves + UI ghosts): `validRoadEdges`/`validSettlementVertices`/`validCityVertices` (paid builds), `connectedRoadEdges` (Road Building's free roads), `bankTradeRate` (ports). Awards live in `src/game/awards.ts` and are recomputed by `updateAwards` after every board/knight-changing move.
- VP = settlements/cities + VP dev cards + 2 per award — all inside `vpCounts`, so `endIf` needs no changes.
- Three.js stays inside `src/three/*`; `GameView` is the sole React-facing facade via `GameCanvas` imperative props. `scenery.ts` and `pieces.ts` own reusable miniature geometry/materials. Ghosts are constrained per-mode via `BuildMode.allowedVertices/allowedEdges`.
- **No hooks after the `if (!G || !ctx) return` early return in `GamePage`** — the first render has `state === null`.
- Don't leave `npm run dev` running unattended across sessions.

## Morning checklist

```bash
cd /c/catan
npm run typecheck && npm test        # expect 124/124
npm run dev                          # hotseat → http://localhost:3000/game
node dist/game/gameServer.js         # separate terminal → :8000 for /online
# or everything containerized:
docker compose up --build -d         # → :3000 web + :8000 game (both healthy)
```

## Visual revision
Dice retain canvas pip textures (no asynchronous SVG replacement); SVG HUD faces have explicit dimensions. Dice settle beyond the land tiles. Ports use low ivory medallions, planked jetties and sailboats. The HUD returns to maritime ink/brass with an active-player card and legible resource rows. Verified 3D dice with an isolated renderer roll; typecheck and Docker build pass.

## Table UX revision

- Desktop: player rail on the left, a larger island in the center, ivory resource hand below, compact Build / Trade / Develop actions on the right. End turn stays reachable.
- Mobile: player totals above the map, the current hand below it, scrollable actions, and a native Table hands dialog for local open-information play.
- Online opponents show card totals only; server playerView still masks resource identities and unplayed development cards. Local hands remain visible.
- GameState.lastPlayedCard is a public, optional persisted record of actual plays. Every seat sees the announcement; it fades after seven seconds and can be reopened from the player rail. Purchases remain secret.
- Number labels have a larger depth offset and a dedicated render order; double-digit numbers use a smaller type size. Denser forests, wheat, cliffs and rocks bring the board closer to the concept.
- The hand tray now shows the active player's resource cards and development cards together. A soundboard sits below Around the table with Imperial march, Knight, City build, Dice, Trade and Robber cues. Imperial march attempts to play when the table mounts and retries on the first interaction if browser autoplay blocks it. City builds use `starship-1.mp3`; Knights use `knight_moat3.mp3`.
- Verification: 120 tests, including public played-card announcements and unchanged private hands. Browser smoke covered a populated main turn, dice, action tabs, a bank exchange, Road Building announcement, phone layout and local hand dialog. Temporary fixtures live only under ignored work/ and are not imported by the app.

Local runtime: ports 3000/8000 belong to another project. Catan .env selects web 3011 / game 8011. Docker defaults remain 3000/8000. Rebuild after changing VITE_GAME_SERVER_PORT. Non-hashed art assets now use no-cache, and MP3 responses use audio/mpeg.

## September 11 design completion

- `src/game-ui.css` owns the responsive table grid; loaded after the global stylesheet by `__root.tsx`. Removed the accumulated earlier table-layout overrides. Desktop players, island, hand and turn controls occupy separate grid areas. Mobile uses normal page flow; sound controls no longer overlap turn controls. End turn has a panel footer and waits for dice animation to finish.
- `HandTray.tsx` keeps resources alongside grouped development cards and shows counts/readiness. `GameIcon.tsx` supplies consistent engraved SVG action/card icons. Opening development actions scrolls to the visible section. Local open hands and online playerView privacy are unchanged.
- `GameAudioProvider` owns one playback channel; `SoundToggle` and `Soundboard` consume it. Default intro respects autoplay restrictions, retries on interaction, and removes pending retries on stop/mute/unmount. Manual transport includes track selection, stop, volume and three quick cues. Added four cue regression tests (124 tests total).
- `GameView` now has a beveled timber/brass frame with corner studs, cream tile borders, varied woodland, irregular crags, sheep legs and shoreline rocks. Repeated scenery is instanced. Board-specific GPU resources are disposed on island rebuild. Canvas number plates keep all numbers readable; ivory dice remain intact. `GameCanvas` exposes reset/zoom buttons without leaking Three.js into React.
- Browser checks: full eight-placement setup, starting resources, dice showing 1 + 3 = 4, turn handoff, camera reset, autoplay gesture retry, 1280×720 and 390×844 layouts, and a populated hand with two Knights, a new Road Building card and a Victory Point card. Temporary QA pages and fixture source were removed before building.

## September 11 miniature refinement

- `scenery.ts` replaces mountain boulders with connected, textured slate ridges; forests use irregular eight-tier fir branch geometry; wheat uses planted rows of stems, folded leaves, paired grain kernels and awns. All respect the central number plate. Vegetation is batched through the existing instancer; unique mountain geometry is disposed on reseed.
- `pieces.ts` replaces pyramidal roofs with carved, bevelled triangular gables, painted wood grain, eaves, ridges, doors and windows. Cities have two wings and a taller central tower. Geometry and materials are shared. React and the game engine still exchange plain data through GameView.
- Generated three new native imagegen material PNGs under `public/assets/astra/details/`, using `concept/island.png` as reference. Optional manifest v2 detail slots retain procedural fallbacks; the asset kit and exact prompt record are updated.
- Luna medium agents handled building models, renderer integration, geometry tests and regression review. Validation: 127 tests passed, TypeScript passed, and a temporary browser fixture showed all terrain types plus settlements/cities in all four colors. Zoomed visual review confirmed number 12, readable forest shading and no browser warnings/errors. The fixture was removed before the production build.
- Production Docker build passed; web 3011 returns HTTP 200 with manifest v2 and game 8011 is healthy. Live production smoke placed Red's settlement and connecting road, awarded 1 VP, and advanced setup to Blue. Temporary Vite 3010 was stopped.

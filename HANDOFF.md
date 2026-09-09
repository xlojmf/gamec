# Handoff — resume here

**Project:** Catan 3D — unofficial fan re-implementation, TanStack Start + Three.js + boardgame.io.
**PRD:** [`PRD.md`](./PRD.md) (§5 = rules contract, §6 = milestones, §7 = multiplayer design). **Status tracker:** `src/data/milestones.ts` (keep in sync with PRD + README).

## Where we are

M0–M11 done, committed, all green (typecheck ✅ · 70/70 tests ✅ · build ✅ · dev smoke ✅):

| Milestone | Commit |
|---|---|
| M0–M5 scaffold, board, terrain, placement sandbox, camera, Docker | `c4aa76f` |
| M6 dice (3D throw, 7→robber mode) | `76695d8` |
| M7 resource production (hands, bank, pulses) | `af95e2e` |
| M8 player turns (boardgame.io engine, hotseat) | `0434064` |
| M9 building rules (costs, supply, connectivity, upgradeCity) | `0ac2ea6` |
| M10 trading (bank/ports, domestic propose-accept) | `48a7931` |
| M11 dev cards & awards | `24aeee1` |

The hotseat game is the **complete base game**: setup draft → roll/produce → trade (maritime + domestic) → build with full rules → dev cards (Knight/Road Building/Year of Plenty/Monopoly/VP) → Longest Road & Largest Army → 10 VP win.

## Next up: M12 — Multiplayer

PRD §7 is the contract (diagram at the top of that section). Scope:

1. **bgio server** as a compose `game` service (`src/server/gameServer.ts` + `Dockerfile` + compose entry, ws on 8000, healthcheck). `Server({ games: [CatanGame] })` — the `setup(ctx, setupData)` path already honors `setupData.seed` for exactly this.
2. **Lobby/join flow** — landing page (`/`) gets "create room" (server picks/randomizes the seed) and "join code" entry. boardgame.io's lobby API (`lobbyClient.createMatch('catan-3d', { numPlayers: 4, setupData: { seed } })`) or a thin custom REST route on the game server. Keep room codes short (PRD open question: 4 vs 6 chars).
3. **Client switch** — `useCatanClient` gains a multiplayer mode: `Client({ game, playerID, matchID, multiplayer: SocketMaster('ws://host:8000') })`. Hotseat stays available (route query flag `/game?hotseat=1`).
4. **Hidden information** — hands of other players must not be sent in full: use bgio's `playerView`/secret state (strip other `hands`/`devHands` to counts) and re-derive the HUD from `G` counts + own hand. The G shape is already prepared (dev VP cards were kept countable for this).
5. **Reconnect** — bgio match IDs + player credentials in `sessionStorage`; refresh resumes (PRD acceptance: "refresh reconnects").
6. **Seats UI** — join as Red/Blue/…, show which seat you occupy; observer mode optional.
7. Docker: `docker compose up` runs `web` + `game`; CORS for the ws origin.

Files to touch: new `src/server/*`, `docker-compose.yml`, `src/routes/index.tsx` (lobby), `src/routes/game.tsx` (multiplayer mode + hidden-hands HUD), maybe `src/game/catan.ts` (`playerView` — pure, testable).

## boardgame.io 0.50 gotchas (learned the hard way — read before touching the engine)

- **Local `Client` does NOT forward `setupData`** → hotseat uses the `createCatanGame(seed)` factory. The server/multiplayer path DOES forward it — that's the M12 path.
- `INVALID_MOVE` is the **string** `'INVALID_MOVE'` from `boardgame.io/core` — not a Symbol.
- Triggers (`endIf`, phase `next`, order `first`/`next`) receive `{ G, ctx }`; **hooks (`onBegin` etc.) must return G** or state becomes undefined.
- Phase `endIf` is evaluated **at turn end** — a move must call `events.endTurn()` for it to fire.
- `events`/`random`/`playerID` are **separate move args**, not on `ctx`.
- **Rejected moves still advance the seeded rng** — tests that roll "until 7" see different sequences depending on prior rejected dispatches.
- bgio state is immer-frozen → in tests `structuredClone(state.G)` before mutating (see `fakeG` / `mainG`).
- **The `seed` client option does NOT make the 0.50 local client's rng deterministic** — rolls are effectively Math.random-backed and a "guaranteed non-7" roll can still come up 7. Tests must tolerate surprise 7s: use `rollUntilProducing(client, seed)` (resolves discard/move/steal and re-rolls) instead of asserting on one roll. Consequence: **it may end turns internally** — always assert relative to the *actual* current player after calling it, never hard-code `'0'`/`'1'`. For real determinism derive from `mulberry32(seed)` in setup (the dev deck does this via `makeDevDeck`).
- Main phase turn order is a custom `mainOrder` (CONTINUE-style) so player 0 — the last setup placer — takes the first turn.
- **Unit-testing moves without a client**: `CatanGame.phases.main.moves.X({ G, ctx }, args)` works on a `structuredClone`d G + plain ctx (see `mainG`/`ctx0` in `catan.test.ts`) — precise, deterministic, no rng drift. Stage moves live at `CatanGame.phases.main.turn.stages.<stage>.moves` (see `respondMoves`). Fake `random` via `{ Die: () => 1 }`.
- **`setActivePlayers({ value })` locks the current player out of ALL moves** until every stage player calls `events.endStage()` — used by the trade `respond` stage (and the `discard` stage) to block the turn while someone else must act.

## Architecture rules (unchanged)

- `src/game/*` = pure, no framework imports, Maps allowed *outside* bgio state; **G stays JSON-serializable** (buildings are `Record`s, never Maps). Board is regenerated from `G.seed` via `boardFor()` (cached). Dev deck order is derived from the seed (`makeDevDeck`), never stored randomness beyond the array itself.
- Validators are the single source of truth for legality (moves + UI ghosts): `validRoadEdges`/`validSettlementVertices`/`validCityVertices` (paid builds), `connectedRoadEdges` (Road Building's free roads), `bankTradeRate` (ports). Awards live in `src/game/awards.ts` (`longestRoadLength` DFS with opponent-junction cutting, `claimAward` transfer rules) and are recomputed by `updateAwards` after every board/knight-changing move.
- VP = settlements/cities + VP dev cards (counted immediately, PRD §5.6) + 2 per award — all inside `vpCounts`, so `endIf` needs no changes.
- `src/three/GameView.ts` is the only file that touches Three.js; React ↔ it via `GameCanvas` imperative props (`roll`, `production`, `robberMode`, `robberTileId` all nonce/identity-driven effects). Ghosts are constrained per-mode via `BuildMode.allowedVertices/allowedEdges`; city ghosts float above the settlement they'd upgrade.
- **No hooks after the `if (!G || !ctx) return` early return in `GamePage`** — the first render has `state === null`, so any hook below it changes the hook count between renders and crashes React (bit us once: a stray `useMemo` for the static island legend; static data belongs at module scope).
- Don't leave `npm run dev` running unattended across sessions — a stray dev process once clobbered `src/routes/game.tsx` back to the route scaffold (git restore + re-apply if that happens again).

## Morning checklist

```bash
cd /c/catan
npm run typecheck && npm test        # expect 70/70
npm run dev                          # → http://localhost:3000/game (hotseat)
# docker: docker compose up --build  # → http://localhost:3000 (+ game service from M12)
```

Then start M12 (above). After M12: polish + art track A1–A3 (GPT Astra textures via the manifest slots in `public/assets/astra/`), then v1.

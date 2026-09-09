# Handoff — resume here

**Project:** Catan 3D — unofficial fan re-implementation, TanStack Start + Three.js + boardgame.io.
**PRD:** [`PRD.md`](./PRD.md) (§5 = rules contract, §6 = milestone table). **Status tracker:** `src/data/milestones.ts` (keep in sync with PRD + README).

## Where we are

M0–M10 done, committed, all green (typecheck ✅ · 52/52 tests ✅ · build ✅ · dev+Docker smoke ✅):

| Milestone | Commit |
|---|---|
| M0–M5 scaffold, board, terrain, placement sandbox, camera, Docker | `c4aa76f` |
| M6 dice (3D throw, 7→robber mode) | `76695d8` |
| M7 resource production (hands, bank, pulses) | `af95e2e` |
| M8 player turns (boardgame.io engine, hotseat) | `0434064` |
| M9 building rules (costs, supply, connectivity, upgradeCity) | `0ac2ea6` |
| M10 trading (bank/ports, domestic propose-accept) | `48a7931` |

The game currently plays the full base game minus dev cards: snake-draft setup → roll/produce → trade (maritime 4:1/3:1/2:1 + domestic with accept/decline overlay) → build with full rules → 7 flow → 10 VP win.

## Next up: M11 — Development cards & awards

PRD §5.4 + §5.5 are the contract. Scope:

1. **Deck** — 14 Knights, 2 Road Building, 2 Year of Plenty, 2 Monopoly, 5 VP cards (25 total). Keep the remaining order as a plain string array in G (JSON-serializable). Deterministic initial shuffle from `G.seed` via `mulberry32`/`shuffled` from `src/game/rng.ts` — avoids ctx.random entirely (see rng gotcha below).
2. **`buyDevCard`** move — cost ⛏+🐑+🌾 (the purchase deferred from M9); draws the top card into `G.devHands[player]` as `{ card, boughtTurn: ctx.turn }`. Bank interaction: cards are paid to the bank like builds.
3. **Play restrictions** — at most 1 dev card per turn; never the card bought this turn (VP cards are the exception: may be revealed immediately if it wins). Track via a `G.devPlayedAtTurn` stamp.
4. **Effects**: Knight (reuse the robber flow — knight play = `beginRobberFlow`-style move+steal without the discard step); Road Building (2 free roads, normal placement rules — reuse `validRoadEdges`); Year of Plenty (any 2 resources from bank, may be same, respect empty stacks); Monopoly (name a resource, every other player hands over all of it).
5. **Awards**: Largest Army (3+ played knights, 2 VP, stolen when exceeded) and Longest Road (≥5 segments, 2 VP, stolen when exceeded). Put the road-path algorithm in a new pure `src/game/awards.ts` — DFS over own edges where junctions with opponent buildings sever the path (`connectsThrough` in catan.ts is the building block; consider exporting it). Store award holders in G; recompute after builds/upgrades/knights.
6. **VP win check** — `endIf`/`vpCounts` must include awards (2 each) + revealed VP cards. Note: VP cards stay hidden until revealed; in hotseat the HUD shows them, but keep the G shape ready for M12 hidden state.
7. **UI**: Dev card buy button in the Build row (cost tag), per-player dev hand panel (card names + play buttons), knight play reuses the existing robber move mode, log lines for draws keep the card secret ("Red drew a development card").

Files to touch: `src/game/catan.ts`, new `src/game/awards.ts`, `src/game/catan.test.ts` (+ `awards.test.ts`), `src/routes/game.tsx`, `src/styles.css`.

## boardgame.io 0.50 gotchas (learned the hard way — read before touching the engine)

- **Local `Client` does NOT forward `setupData`** → use `createCatanGame(seed)` factory (already in `catan.ts`). The `setup(ctx, setupData)` path still exists for the M12 server.
- `INVALID_MOVE` is the **string** `'INVALID_MOVE'` from `boardgame.io/core` — not a Symbol.
- Triggers (`endIf`, phase `next`, order `first`/`next`) receive `{ G, ctx }`; **hooks (`onBegin` etc.) must return G** or state becomes undefined.
- Phase `endIf` is evaluated **at turn end** — a move must call `events.endTurn()` for it to fire.
- `events`/`random`/`playerID` are **separate move args**, not on `ctx`.
- **Rejected moves still advance the seeded rng** — tests that roll "until 7" see different sequences depending on prior rejected dispatches.
- bgio state is immer-frozen → in tests `structuredClone(state.G)` before mutating (see `fakeG` / `mainG`).
- **The `seed` client option does NOT make the 0.50 local client's rng deterministic** — rolls are effectively Math.random-backed and a "guaranteed non-7" roll can still come up 7. Tests must tolerate surprise 7s: use `rollUntilProducing(client, seed)` (resolves discard/move/steal and re-rolls) instead of asserting on one roll. Consequence: **it may end turns internally** — always assert relative to the *actual* current player after calling it, never hard-code `'0'`/`'1'`. The `seed` option is also untyped — cast as in `makeClient`. (For real determinism, derive from `mulberry32(seed)` in setup instead — do this for the dev deck.)
- Main phase turn order is a custom `mainOrder` (CONTINUE-style) so player 0 — the last setup placer — takes the first turn.
- **Unit-testing moves without a client**: `CatanGame.phases.main.moves.X({ G, ctx }, args)` works on a `structuredClone`d G + plain ctx (see `mainG`/`ctx0` in `catan.test.ts`) — precise, deterministic, no rng drift. Stage moves live at `CatanGame.phases.main.turn.stages.<stage>.moves` (see `respondMoves`).
- **`setActivePlayers({ value })` locks the current player out of ALL moves** until every stage player calls `events.endStage()` — used by the trade `respond` stage (and the `discard` stage) to block the turn while someone else must act.

## Architecture rules (unchanged)

- `src/game/*` = pure, no framework imports, Maps allowed *outside* bgio state; **G stays JSON-serializable** (buildings are `Record`s, never Maps). Board is regenerated from `G.seed` via `boardFor()` (cached).
- Build validators (`validRoadEdges` / `validSettlementVertices` / `validCityVertices`) include **affordability + supply + geometry** — single source of truth for moves and UI ghost sets. Trade rate logic likewise lives in `bankTradeRate(G, player, resource)`.
- `src/three/GameView.ts` is the only file that touches Three.js; React ↔ it via `GameCanvas` imperative props (`roll`, `production`, `robberMode`, `robberTileId` all nonce/identity-driven effects). Ghosts can be constrained per-mode via `BuildMode.allowedVertices/allowedEdges` (Sets); city ghosts float above the settlement they'd upgrade.
- Dice/robber visuals: `rollDice()` animates then fires `onRollDone`; production pulses via `showProduction(tileIds)`; robber hop via `setRobberTile`.

## Morning checklist

```bash
cd /c/catan
npm run typecheck && npm test        # expect 52/52
npm run dev                          # → http://localhost:3000/game
# docker: docker compose up --build  # → http://localhost:3000
```

Then start M11 (above). After M11: M12 multiplayer (bgio server as compose `game` service, PRD §7), art track A1–A3 in parallel.

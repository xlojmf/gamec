# Handoff — resume here

**Project:** Catan 3D — unofficial fan re-implementation, TanStack Start + Three.js + boardgame.io.
**PRD:** [`PRD.md`](./PRD.md) (§5 = rules contract, §6 = milestone table). **Status tracker:** `src/data/milestones.ts` (keep in sync with PRD + README).

## Where we are

M0–M9 done, committed, all green (typecheck ✅ · 45/45 tests ✅ · build ✅ · Docker ✅):

| Milestone | Commit |
|---|---|
| M0–M5 scaffold, board, terrain, placement sandbox, camera, Docker | `c4aa76f` |
| M6 dice (3D throw, 7→robber mode) | `76695d8` |
| M7 resource production (hands, bank, pulses) | `af95e2e` |
| M8 player turns (boardgame.io engine, hotseat) | `0434064` |
| M9 building rules (costs, supply, connectivity, upgradeCity) | `3d32feb` |

The game currently plays: snake-draft setup → roll/produce/build turns → 7 flow (discard/move/steal) → 10 VP win — with **full building rules**: costs paid to the bank, 15/5/4 supply caps, road connectivity (opponent settlements cut junctions), distance rule, city upgrades. Ghost highlights in both setup and main phase show only *legal* spots via `BuildMode.allowedVertices/allowedEdges`.

## Next up: M10 — Trading

PRD §5.3.2 is the contract. Scope:

1. **Bank trade 4:1** — `tradeBank(give: Partial<ResourceCounts>, take: Partial<ResourceCounts>)` move: give exactly 4 of one resource for 1 of another (M10 keeps it to 4:1 unless ports come cheap); give returns to bank, take leaves bank (respect empty stacks).
2. **Ports** — 3:1 generic and 2:1 special; port data is already on the board (`board.ports`, vertices carry `portId`). A player with a building on a port's corner vertex gets that rate. `bestTradeRate(G, player, resource)` helper: 2 if own building on the matching special port, else 3 if on any generic port, else 4.
3. **Domestic trades** (player-to-player): hardest for hotseat UI — propose/accept flow. Consider a simple overlay: active player picks partner + give/take stacks, partner accepts (both dispatch as the active player in hotseat, but validate consent via a two-step move, e.g. `proposeTrade` + `acceptTrade` with a `pendingTrade` in G, mirroring the `robberStep` pattern).
4. **UI**: trade panel in the HUD (steppers like `DiscardPanel`), log lines, keep hand/bank conservation tested.

Files to touch: `src/game/catan.ts` (moves + `bestTradeRate`), `src/game/catan.test.ts`, `src/routes/game.tsx` (trade UI). VP, production, buildings all already work off `G`.

## boardgame.io 0.50 gotchas (learned the hard way — read before touching the engine)

- **Local `Client` does NOT forward `setupData`** → use `createCatanGame(seed)` factory (already in `catan.ts`). The `setup(ctx, setupData)` path still exists for the M12 server.
- `INVALID_MOVE` is the **string** `'INVALID_MOVE'` from `boardgame.io/core` — not a Symbol.
- Triggers (`endIf`, phase `next`, order `first`/`next`) receive `{ G, ctx }`; **hooks (`onBegin` etc.) must return G** or state becomes undefined.
- Phase `endIf` is evaluated **at turn end** — a move must call `events.endTurn()` for it to fire.
- `events`/`random`/`playerID` are **separate move args**, not on `ctx`.
- **Rejected moves still advance the seeded rng** — tests that roll "until 7" see different sequences depending on prior rejected dispatches.
- bgio state is immer-frozen → in tests `structuredClone(state.G)` before mutating (see `fakeG` / `mainG`).
- The `seed` client option (rng determinism) is untyped in 0.50 — cast as in `makeClient`.
- Main phase turn order is a custom `mainOrder` (CONTINUE-style) so player 0 — the last setup placer — takes the first turn.
- **Unit-testing moves without a client**: `CatanGame.phases.main.moves.placeRoad({ G, ctx }, args)` works on a `structuredClone`d G + plain ctx (see `mainG`/`ctx0` in `catan.test.ts`) — precise, deterministic, no rng drift.

## Architecture rules (unchanged)

- `src/game/*` = pure, no framework imports, Maps allowed *outside* bgio state; **G stays JSON-serializable** (buildings are `Record`s, never Maps). Board is regenerated from `G.seed` via `boardFor()` (cached).
- Build validators (`validRoadEdges` / `validSettlementVertices` / `validCityVertices`) include **affordability + supply + geometry** — they are the single source of truth for both the moves and the UI ghost sets. Keep it that way.
- `src/three/GameView.ts` is the only file that touches Three.js; React ↔ it via `GameCanvas` imperative props (`roll`, `production`, `robberMode`, `robberTileId` all nonce/identity-driven effects). Ghosts can be constrained per-mode via `BuildMode.allowedVertices/allowedEdges` (Sets); city ghosts float above the settlement they'd upgrade.
- Dice/robber visuals: `rollDice()` animates then fires `onRollDone`; production pulses via `showProduction(tileIds)`; robber hop via `setRobberTile`.

## Morning checklist

```bash
cd /c/catan
npm run typecheck && npm test        # expect 45/45
npm run dev                          # → http://localhost:3000/game
# docker: docker compose up --build  # → http://localhost:3000
```

Then start M10 (above). After M10: M11 dev cards + awards, M12 multiplayer (bgio server as compose `game` service, PRD §7), art track A1–A3 in parallel.

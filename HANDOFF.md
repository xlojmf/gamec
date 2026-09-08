# Handoff — resume here

**Project:** Catan 3D — unofficial fan re-implementation, TanStack Start + Three.js + boardgame.io.
**PRD:** [`PRD.md`](./PRD.md) (§5 = rules contract, §6 = milestone table). **Status tracker:** `src/data/milestones.ts` (keep in sync with PRD + README).

## Where we are

M0–M8 done, committed, all green (typecheck ✅ · 35/35 tests ✅ · build ✅ · Docker ✅):

| Milestone | Commit |
|---|---|
| M0–M5 scaffold, board, terrain, placement sandbox, camera, Docker | `c4aa76f` |
| M6 dice (3D throw, 7→robber mode) | `76695d8` |
| M7 resource production (hands, bank, pulses) | `af95e2e` |
| M8 player turns (boardgame.io engine, hotseat) | `0434064` |

The game currently plays: snake-draft setup → roll/produce/build turns → 7 flow (discard/move/steal) → 10 VP win. Building is still **free placement** (that's M9's job).

## Next up: M9 — Building rules

PRD §5.3.3 + §5.7 are the contract. Scope:

1. **Costs** (paid to bank): road 1🪵+1🧱, settlement 1🪵+1🧱+1🌾+1🐑, city 2🌾+3⛏, dev card ⛏+🐑+🌾 (dev cards themselves are M11 — skip the purchase move until then).
2. **Supply limits**: 15 roads / 5 settlements / 4 cities per player (count from `G.buildings`).
3. **Connectivity**: roads must touch own road network or own building; opponent settlement on a junction breaks road continuity (matters for longest road, M11).
4. **Distance rule** for settlements in the main phase (already enforced in setup — see `validSetupVertices`).
5. **City upgrade** — new `upgradeCity(vertexId)` move replacing an own settlement (settlement piece returns to supply).
6. **UI**: city button in Build row; affordability display on hands; ideally filter the ghost highlights to *legal* spots (export validators from `src/game/catan.ts`, use them in `game.tsx` to compute the mode/ghost sets — today ghosts show every empty spot and clicks are validated only on dispatch).

Files to touch: `src/game/catan.ts` (moves + validators), `src/game/catan.test.ts`, `src/routes/game.tsx` (Build UI), maybe `src/three/GameView.ts` (ghost filtering API). VP already counts cities (settlement 1 / city 2 in `vpCounts`).

## boardgame.io 0.50 gotchas (learned the hard way — read before touching the engine)

- **Local `Client` does NOT forward `setupData`** → use `createCatanGame(seed)` factory (already in `catan.ts`). The `setup(ctx, setupData)` path still exists for the M12 server.
- `INVALID_MOVE` is the **string** `'INVALID_MOVE'` from `boardgame.io/core` — not a Symbol.
- Triggers (`endIf`, phase `next`, order `first`/`next`) receive `{ G, ctx }`; **hooks (`onBegin` etc.) must return G** or state becomes undefined.
- Phase `endIf` is evaluated **at turn end** — a move must call `events.endTurn()` for it to fire.
- `events`/`random`/`playerID` are **separate move args**, not on `ctx`.
- **Rejected moves still advance the seeded rng** — tests that roll "until 7" see different sequences depending on prior rejected dispatches.
- bgio state is immer-frozen → in tests `structuredClone(state.G)` before mutating (see `fakeG`).
- The `seed` client option (rng determinism) is untyped in 0.50 — cast as in `makeClient`.
- Main phase turn order is a custom `mainOrder` (CONTINUE-style) so player 0 — the last setup placer — takes the first turn.

## Architecture rules (unchanged)

- `src/game/*` = pure, no framework imports, Maps allowed *outside* bgio state; **G stays JSON-serializable** (buildings are `Record`s, never Maps). Board is regenerated from `G.seed` via `boardFor()` (cached).
- `src/three/GameView.ts` is the only file that touches Three.js; React ↔ it via `GameCanvas` imperative props (`roll`, `production`, `robberMode`, `robberTileId` all nonce/identity-driven effects).
- Dice/robber visuals: `rollDice()` animates then fires `onRollDone`; production pulses via `showProduction(tileIds)`; robber hop via `setRobberTile`.

## Morning checklist

```bash
cd /c/catan
npm run typecheck && npm test        # expect 35/35
npm run dev                          # → http://localhost:3000/game
# docker: docker compose up --build  # → http://localhost:3000
```

Then start M9 (above). After M9: M10 trading (bank 4:1, ports — port data already on board edges), M11 dev cards + awards, M12 multiplayer (bgio server as compose `game` service, PRD §7), art track A1–A3 in parallel.

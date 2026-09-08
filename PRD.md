# Product Requirements Document — **Catan 3D**

> An unofficial, non-commercial fan re-implementation of *The Settlers of Catan* for the browser.
> Catan™ is a trademark of Catan Studio / Asmodee. This project is for personal & educational use only.

| | |
|---|---|
| **Status** | In active development (M0–M5 complete) |
| **Version** | 0.1.0 |
| **Owner** | you 🙂 |
| **Repo** | `catan/` |

---

## 1. Vision

A beautiful, fully playable browser adaptation of the classic island-building game:

- A **stylized 3D island** rendered with **Three.js** — hex terrain, little trees, sheep, mountains, a robber.
- A **complete rules engine** for the 3–4 player base game (dice, production, trading, development cards, longest road / largest army).
- **Multiplayer** powered by **boardgame.io** — hotseat/local first, online rooms later, without rewriting the game logic.
- An **art direction driven by GPT Astra**: concept boards, tile textures and UI kit generated as images, dropped into the game through an asset manifest.
- Everything **runs via Docker**: `docker compose up` and play.

### North-star experience
Open a link → see a warm, hand-crafted-feeling island floating in the sea → rotate/zoom it → roll dice that *feel* good → place roads and settlements with satisfying feedback → trade, expand, race to 10 victory points.

---

## 2. Goals & Non-Goals

### Goals (v1)
- G1 — Full base-game rules for 3–4 players (no expansions).
- G2 — Playable solo (hotseat / local sandbox) and online (rooms with join codes).
- G3 — 60 fps 3D board on a mid-range laptop, desktop-first.
- G4 — GPT Astra art pipeline: regenerate the entire look & feel by swapping generated images.
- G5 — Single command to run: `docker compose up --build`.

### Non-Goals (v1)
- 5–6 player extension, Cities & Knights, Seafarers.
- AI opponents (possible stretch after v1).
- Accounts / authentication — room codes only.
- Mobile-first UX (mobile *playable* is nice-to-have, not a requirement).
- Official branding / commercial release.

---

## 3. Tech Stack & Rationale

| Layer | Choice | Why | Main risk & mitigation |
|---|---|---|---|
| Rendering | **Three.js** (vanilla, no R3F) | Full control of scene, render loop and picking for a board game; no React-reconciler overhead; `OrbitControls` from `three/addons`. | More manual sync code → mitigated by a thin `GameView` facade class that is the *only* place touching Three.js. |
| App framework | **TanStack Start** (React 19 + Vite, SSR) | Modern full-stack TypeScript; file-based routes for `/`, `/game`, `/rules`; same repo can later host the boardgame.io server. | Young framework, API churn → pin versions, keep framework usage shallow (routes + components only). |
| Game engine | **boardgame.io** | Rules as pure `moves` + `phases` + turn order; built-in random (seeded), viewable/secret state, transport, lobby, persistence. Local mode now → multiplayer later with near-zero logic rewrite. | Framework opinions differ from ours → the pure logic lives in `src/game/*` with plain data in/out, boardgame.io is a thin adapter. |
| Multiplayer transport | boardgame.io socket.io server | Reconnect support, lobby API, rooms. | — |
| Art | **GPT Astra** (image generation) | Generate concept boards, PBR-ish tile textures, water, UI kit; iterate cheaply on look & feel. | Generated assets inconsistent → asset manifest + prompt recipe doc so every slot is swappable/regenerable; procedural fallback always works. |
| Packaging | **Docker** (multi-stage) + **compose** | Reproducible deploys; `web` and (later) `game` services. | — |
| Language | TypeScript strict everywhere | Multiplayer correctness depends on shared types. | — |
| Tests | **Vitest** | Unit-test board generation & rules engine as pure functions. | — |

---

## 4. Architecture

```
                        ┌──────────────────────────────────────────────┐
   Browser              │  TanStack Start app (React 19, SSR) :3000    │
                        │                                              │
   /        landing     │  /game        three.js <canvas> + HUD        │
   /rules   rules ref   │  /rules       rules reference page           │
                        │                                              │
                        │  ┌────────────────┐   ┌────────────────────┐ │
                        │  │ src/three/*    │   │ src/game/* (PURE)  │ │
                        │  │ GameView       │◄──┤ board generation,  │ │
                        │  │ scene, picking │   │ rules, types       │ │
                        │  └────────────────┘   └─────────┬──────────┘ │
                        │                                 │ adapter    │
                        │                    M8+: boardgame.io Client │
                        │                    (local now → socket M12) │
                        └─────────────────────────────────┬────────────┘
                                                          │ ws :8000 (M12)
                        ┌─────────────────────────────────▼────────────┐
   Docker compose       │  game service — boardgame.io server          │
                        │  web service  — TanStack Start node server   │
                        └──────────────────────────────────────────────┘
```

### Repo layout

```
catan/
├── PRD.md                  ← this document
├── README.md               ← quickstart + milestone tracker
├── Dockerfile              ← multi-stage build of the web app
├── docker-compose.yml      ← web (+ game service in M12)
├── vite.config.ts          ← tanstackStart() plugin
├── src/
│   ├── router.tsx
│   ├── routes/             ← __root, /, /game, /rules
│   ├── components/         ← GameCanvas (React ↔ GameView bridge)
│   ├── three/GameView.ts   ← ALL Three.js lives here
│   ├── game/               ← pure logic, no React/Three imports
│   │   ├── rng.ts          ← seeded RNG (mulberry32)
│   │   ├── terrain.ts      ← terrain/resource definitions
│   │   ├── board.ts        ← hex board generation (tiles, vertices, edges, ports)
│   │   └── board.test.ts
│   ├── data/               ← milestones, rules content
│   └── styles/app.css
└── public/assets/astra/    ← M-A: generated art slots + manifest.json (art track)
```

### Key architectural decisions

1. **Pure game core.** `src/game/*` contains zero framework imports — it is data-in/data-out. This is what makes the boardgame.io adoption (M8/M12) a configuration change instead of a rewrite.
2. **Single rendering facade.** Only `GameView` knows Three.js exists. React feeds it plain state (`board`, `placements`, `buildMode`) through `GameCanvas` and receives pick/hover events back.
3. **Determinism.** The board (terrain shuffle, number tokens, ports, prop placement) is a pure function of a `seed`. In multiplayer the server owns the seed; every client renders the identical island. All future randomness (dice) will also flow through boardgame.io's seeded random.
4. **Asset manifest.** Procedural placeholder art now; GPT Astra slots later. The renderer looks textures up through a manifest with code fallback, so art can be regenerated without code changes.

### Data flow (today and at M8+)

```
Today:    UI event → React state → GameView.setSceneState → meshes
M8+:      UI event → boardgame.io move → server-reduced state → React → GameView → meshes
```

---

## 5. Game Rules Reference (base game, 3–4 players)

This section is the implementation contract for M6–M11.

### 5.1 Components
- 19 terrain hexes: **4 Forest, 4 Pasture, 4 Fields, 3 Hills, 3 Mountains, 1 Desert**.
- 18 number tokens **2–12 (no 7)**: `2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12`. 6 and 8 are printed red.
- 9 ports: **4 generic (3:1)** and one special 2:1 port for each resource (lumber, wool, grain, brick, ore).
- Each player: **15 roads, 5 settlements, 4 cities** (hard supply limits).
- Resource cards: 19 of each of the 5 resources.
- Development deck: **14 Knights, 2 Road Building, 2 Year of Plenty, 2 Monopoly, 5 Victory Point cards** = 25 cards.
- 2 dice, 1 robber, Largest Army & Longest Road award cards.

### 5.2 Setup
1. Shuffle terrain hexes face-down and assemble the island (rings of 6 and 12 around the desert-capable center).
2. Place number tokens face-up **in a clockwise spiral starting from an outer hex**, ending at the center. *(Our variant: shuffle terrain + spiral numbers + enforce the “no two red numbers (6/8) adjacent” fairness rule by reshuffling.)*
3. Place the robber on the desert.
4. Determine start player randomly. **Snake draft**: P1→P4 each place 1 settlement + 1 connecting road; then P4→P1 place their 2nd settlement + road.
5. Each player takes **1 resource of each type produced by the hexes adjacent to their second settlement**.

### 5.3 Turn structure
A turn = **Roll → (produce or robber) → Trade → Build**. Play passes clockwise.

**1) Roll & produce.** Roll 2 dice; the sum triggers production:
- Each hex with that number produces: **settlement = 1 card, city = 2 cards** of the hex's resource, for every owner of adjacent buildings.
- Blocked rule: the hex with the robber produces nothing.
- Empty-stack rule: if a resource stack is exhausted, players who would draw from it get nothing.

**Rolling a 7 (no production):**
- Every player with **more than 7 cards discards half** (rounded down).
- Active player **moves the robber** to any terrain hex, then **steals 1 random card** from one player who has a building adjacent to that hex (may steal from the only eligible target by choice; if multiple, pick the victim).

**2) Trade.** On your turn only, any order/amount:
- *Domestic*: trade cards with any other player (terms open; only the active player's trades are legal; you may not trade identical resources, e.g. wood for wood).
- *Maritime*: **4:1** with the bank; **3:1** if you have a settlement/city on a generic port; **2:1** on a special port of that resource (ports require a building on one of the port's two corner vertices).

**3) Build.** Any number of things if you can pay (see costs), limited by supply:
- **Road — 1 lumber + 1 brick.** Place on an empty edge **connected** to your road network or one of your buildings. An opponent's settlement on a junction breaks your road continuity (matters for Longest Road).
- **Settlement — 1 lumber + 1 brick + 1 grain + 1 wool.** Empty vertex, **connected** to your road, and the **distance rule**: at least 2 edges away from every other settlement/city (no adjacent buildings).
- **City — 2 grain + 3 ore.** Upgrade one of your own settlements (return the settlement piece to supply).
- **Development card — 1 ore + 1 wool + 1 grain.** Draw from the deck. You may play **at most 1 development card per turn**, and **never the card you bought this turn** (Victory Point cards are the exception: they may be revealed immediately if they win you the game).

### 5.4 Development cards
| Card | Effect |
|---|---|
| Knight (×14) | Move robber + steal 1 card (as after rolling a 7). Counts toward **Largest Army**. |
| Road Building (×2) | Immediately place up to 2 free roads (normal placement rules). |
| Year of Plenty (×2) | Take any 2 resources from the bank (may be the same). |
| Monopoly (×2) | Name a resource; every other player gives you **all** their cards of it. |
| Victory Point (×5) | 1 VP, kept secret until revealed for the win. |

### 5.5 Special awards
- **Longest Road** — continuous road of ≥5 segments (unique owner). Worth 2 VP; stolen when someone exceeds the current holder.
- **Largest Army** — 3+ played knights (unique owner). Worth 2 VP; stolen when exceeded.

### 5.6 Winning
**First player to 10 VP on their own turn wins.** VP = 1/settlement + 2/city + 2 (Longest Road) + 2 (Largest Army) + 1 per VP dev card.

### 5.7 Costs quick reference
| Piece | Lumber | Brick | Wool | Grain | Ore |
|---|:-:|:-:|:-:|:-:|:-:|
| Road | 1 | 1 | | | |
| Settlement | 1 | 1 | 1 | 1 | |
| City | | | | 2 | 3 |
| Dev card | | | 1 | 1 | 1 |

---

## 6. Milestones

Mapped 1:1 to the incremental build plan. Each milestone ships green (typecheck + tests + manual smoke).

| # | Milestone | Scope | Acceptance criteria | Status |
|---|---|---|---|---|
| M0 | PRD & repo | This document, tooling, Docker skeleton | PRD reviewed; `docker compose up` serves the app | ✅ |
| M1 | Three.js project | TanStack Start + TS strict + Three.js; routes `/`, `/game` | Landing + game routes render; build green | ✅ |
| M2 | Hexagonal board | Pure `generateBoard(seed)`: 19 tiles (axial coords), vertices, edges, ports | Unit tests: 19 tiles / 54 vertices / 72 edges / 9 ports; deterministic per seed | ✅ |
| M3 | Terrain & resource tiles | Procedural visuals per terrain, number tokens (pips, red 6/8), robber, props, ocean | Board visually readable; hover shows tile info | ✅ |
| M4 | Roads & settlements | Building meshes, player colors, build mode UI, click/hover picking *(free placement — rules enforced in M9)* | Can place/remove roads & settlements for 4 players; New Board reseeds | ✅ |
| M5 | Camera controls | OrbitControls (rotate/pan/zoom, limits, damping), intro fly-in, resize | Smooth camera; no clipping through board; resize safe | ✅ |
| M6 | Dice | Roll UI with 3D dice throw feel, sum display, 7 → robber mode | Roll animates; 7 flow begins (robber move/steal UI completes in M8) | ✅ |
| M7 | Resource production | Yield calculation from board state, player hands, bank limits | Correct yields for settlements/cities; robber blocks; stack exhaustion | ✅ |
| M8 | Player turns | boardgame.io local client; setup snake draft; turn phases; robber resolution; discard flow | Full hotseat game runs from setup to 10 VP with rules above | ⏳ next |
| M9 | Building rules | Costs, supply limits, connectivity, distance rule, road-cutting | Illegal builds impossible; costs exact per §5.7 | ⏳ |
| M10 | Trading | Bank 4:1, ports 3:1 & 2:1, player-to-player trade offers | Trades validated per §5.3.2 | ⏳ |
| M11 | Development cards | Deck, play restrictions, Largest Army / Longest Road, VP win check | Dev cards fully functional; awards transfer correctly | ⏳ |
| M12 | Multiplayer | boardgame.io server in compose, lobby/join codes, hidden hands, reconnect | 2+ browsers play one authoritative game; refresh reconnects | ⏳ |

### Art track (parallel, GPT Astra)
| # | Pass | Output |
|---|---|---|
| A1 | Concept & mood boards | `docs/art/concept/` — island mood, palette, lighting refs → lock design tokens |
| A2 | World textures | tile top/side textures ×6 terrains, water, number token plate, frame |
| A3 | UI kit | HUD panels, buttons, icons, dice faces, logo, font pairing |

Each pass writes its prompts to `docs/art/prompts.md` and files into `public/assets/astra/<slot>` registered by `manifest.json`; the renderer falls back to procedural art for any missing slot.

---

## 7. Multiplayer Design (M12)

- **Server**: boardgame.io node server as a `game` compose service on `:8000`; the web client connects with `multiplayer: { server: '<host>:8000', roomID }`.
- **Rooms**: boardgame.io lobby API — create room → 4-char join code → seat selection. No accounts.
- **Secret state**: resource hands & dev cards per-player via boardgame.io secret/`playerID`-scoped state; clients only ever receive their own hand.
- **Determinism**: server owns the board seed + dice (boardgame.io random), clients render from state.
- **Reconnect**: boardgame.io credentials stored in `sessionStorage`; refresh → rejoin same seat.
- **Later (stretch)**: persistence adapter (SQLite/Postgres) so rooms survive server restarts.

---

## 8. Docker & Operations

- `Dockerfile` — multi-stage: `node:22-alpine` build (`npm ci`, `vite build`) → runtime serving `.output/server/index.mjs` on **:3000**.
- `docker-compose.yml` — `web` (this app) now; `game` (boardgame.io) at M12. Healthchecks added with M12.
- Dev loop stays bare-metal (`npm run dev`) for HMR.

---

## 9. Testing Strategy

- **Unit (Vitest)** — board generation invariants (counts, connectivity, no adjacent red numbers, seed determinism) ✅; from M7 every rule move is a pure function tested headlessly (production yields, robber discards, building legality, dev card restrictions).
- **Integration (M8+)** — simulate full games with random bots against the boardgame.io client; assert invariants (card conservation, supply limits, legal wins only).
- **Visual** — manual smoke per milestone; screenshot diffing is a post-v1 nicety.

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| TanStack Start API churn | Medium | Keep framework surface minimal (routes/components); pin versions |
| Longest Road computation (cycles, cutting) | Medium | Well-tested pure function + property tests (M11) |
| Generated art inconsistency | Medium | Manifest + per-slot fallbacks; art never blocks a milestone |
| Scope creep toward full Catan rules parity | High | v1 = base game exactly; expansion features are hard non-goals |
| Performance with props/shadows on low-end GPUs | Low | Shared geometries/materials; pixel-ratio clamp; shadows toggleable |

---

## 11. Open Questions

1. Hotseat + online in one code path (boardgame.io local from M8) — confirmed approach?
2. Art style target for A1: *cozy hand-painted tabletop* vs *low-poly stylized*? (Recommend: cozy hand-painted.)
3. Room codes 4-char vs 6-char for M12?
4. Do we want a spectator mode for streamers? (post-v1)

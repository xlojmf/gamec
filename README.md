# Catan 3D

An unofficial, non-commercial fan re-implementation of *The Settlers of Catan* for the browser — a stylized 3D island built with **Three.js**, served by **TanStack Start**, with **boardgame.io** multiplayer planned and the look & feel driven by **GPT Astra** generated art.

> Catan™ is a trademark of Catan Studio / Asmodee. This project is not affiliated. Personal & educational use only.

📋 **Full product requirements, rules reference, architecture and roadmap: [`PRD.md`](./PRD.md)**

## Quickstart

```bash
npm install
npm run dev          # → http://localhost:3000
```

Or with Docker:

```bash
docker compose up --build   # → http://localhost:3000
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with HMR |
| `npm run build` | Production build (`dist/`) |
| `npm start` | Serve the production build (`server.mjs`, zero-dep node server) |
| `npm test` | Vitest suite (board generation invariants) |
| `npm run typecheck` | Strict TypeScript check |

## Repo map

```
src/
├── game/            pure game logic — no React/Three imports (boardgame.io-ready)
│   ├── board.ts     seeded hex island generator: 19 tiles, 54 vertices, 72 edges, 9 ports
│   └── board.test.ts
├── three/GameView.ts  the only file that touches Three.js
├── components/GameCanvas.tsx  React ↔ Three bridge
├── routes/          / (landing) · /game (island) · /rules (rules reference)
└── data/            milestones + rules content
```

**Architecture rule:** state flows `React → GameView` as plain data; events flow back through callbacks. The pure `src/game/*` layer is what boardgame.io will consume when multiplayer lands (M12), so the online version is a configuration change, not a rewrite.

## Milestones

| # | Milestone | Status |
|---|---|---|
| M0 | PRD & repo | ✅ |
| M1 | Three.js project | ✅ |
| M2 | Hexagonal board (seeded, tested) | ✅ |
| M3 | Terrain & resource tiles (procedural art) | ✅ |
| M4 | Roads & settlements (placement sandbox) | ✅ |
| M5 | Camera controls | ✅ |
| M6 | Dice | ✅ |
| M7 | Resource production | ⏳ next |
| M8 | Player turns (boardgame.io local) | ⏳ |
| M9 | Building rules | ⏳ |
| M10 | Trading | ⏳ |
| M11 | Development cards | ⏳ |
| M12 | Multiplayer (boardgame.io server) | ⏳ |
| A1–A3 | GPT Astra art passes (concept → world textures → UI kit) | ⏳ |

Details and acceptance criteria per milestone: [`PRD.md §6`](./PRD.md).

## Playing today (M6 sandbox)

- Drag to rotate, scroll to zoom, right-drag to pan.
- Pick a player color, choose **Road** or **Settlement**, click a highlighted edge/corner to place; click a placed piece again to remove it.
- Hover hexes to inspect terrain, resource and number token.
- **Roll dice** throws two animated 3D dice onto the ocean; a 7 enters robber mode — click any hex to move him (steal/discard flow lands in M8).
- **New island** regenerates the board from a fresh seed (free placement — rule enforcement arrives in M9).

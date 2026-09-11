# Catan 3D

An unofficial, non-commercial fan re-implementation of *The Settlers of Catan* for the browser — a stylized 3D island built with **Three.js**, served by **TanStack Start**, with **boardgame.io** local and online multiplayer and the look & feel driven by **GPT Astra** generated art.

> Catan™ is a trademark of Catan Studio / Asmodee. This project is not affiliated. Personal & educational use only.

📋 **Full product requirements, rules reference, architecture and roadmap: [`PRD.md`](./PRD.md)**

## Quickstart

For the Coolify VPS deployment at `game.jmfserver.uk`, follow [deploy.md](./deploy.md). It uses `docker-compose.coolify.yml` and a separate HTTPS multiplayer origin.

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
| `npm test` | Vitest rules, board, persistence and websocket integration suite |
| `npm run typecheck` | Strict TypeScript check |

## Repo map

```
src/
├── game/            pure game logic — no React/Three imports (boardgame.io-ready)
│   ├── board.ts     seeded hex island generator: 19 tiles, 54 vertices, 72 edges, 9 ports
│   └── board.test.ts
├── three/           isolated Three.js renderer, scenery and carved building models
├── components/GameCanvas.tsx  React ↔ Three bridge
├── routes/          / (landing) · /game (island) · /rules (rules reference)
└── data/            milestones + rules content
```

**Architecture rule:** state flows `React → GameView` as plain data; events flow back through callbacks. Local and online clients share the same authoritative rules and validators.

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
| M7 | Resource production | ✅ |
| M8 | Player turns (boardgame.io local) | ✅ |
| M9 | Building rules | ✅ |
| M10 | Trading (bank, ports, player trades) | ✅ |
| M11 | Development cards & awards | ✅ |
| M12 | Multiplayer (boardgame.io server) | ✅ |
| M13 | Rules refinements & resilience (official dev timing, 3–4P everywhere, persistence, stall watchdog, rematch) | ✅ |
| A1–A3 | Generated concept, six terrain tops/sides, water, frame, tokens, UI kit | ✅ |
| A4–A6 | Sound, safe build undo, full journal, placement animation, counter-offers and table trades | ✅ |

Details and acceptance criteria per milestone: [`PRD.md §6`](./PRD.md).

## Playing today (M12 — full base game, hotseat + online)

- **Hotseat**: `/game` — same browser, pass the mouse around. Open information.
- **Online (M12)**: `/online` — create a room (4-letter code), share it, each player takes a seat in their own browser. The boardgame.io server (docker `game` service, :8000) owns dice + seed; hands of other players are hidden (card totals only); refresh reconnects to your seat via sessionStorage credentials.
- **Setup**: snake draft — each player places a settlement + connecting road (glowing spots), twice; second settlements pay out starting resources.
- **Turns**: roll the animated 3D dice → producing hexes pulse green and hands update → trade → build / play a dev card → end turn.
- **Building rules (M9)**: costs per PRD §5.7 are paid to the bank (🪵🧱 / 🪵🧱🌾🐑 / 🌾🌾⛏⛏⛏), supply is capped at 15 roads / 5 settlements / 4 cities, roads must connect to your network (an opponent's settlement cuts a junction), settlements obey the distance rule, and cities upgrade your own settlements. Ghost highlights show only legal spots; the City button upgrades a glowing settlement.
- **Trading (M10)**: maritime trades at 4:1, 3:1 with a generic port, or 2:1 with a matching special port (rates show on the give chips); domestic trades via the player-trade overlay — the partner gets an accept/decline card and the turn is locked until they answer.
- **Development cards (M11)**: buy for ⛏🐑🌾 (deck of 25, deterministic per island); play at most one per turn and never the card you just bought. Knight reuses the robber flow and builds toward Largest Army; Road Building paves 2 free roads on glowing spots; Year of Plenty takes 2 bank cards; Monopoly collects a named resource from everyone. VP cards count silently toward the win.
- **Awards (M11)**: Longest Road (≥5, opponent settlements cut chains) and Largest Army (≥3 knights) — 2 VP each, stolen when exceeded, live in the Development panel.
- **Rolling a 7**: over-7-card hands discard half via the overlay, the active player hops the robber to any hex, then steals a random card from a chosen victim.
- Hands, bank stacks (19 each), remaining supply, dev hands and a compact log live in the HUD; first player to 10 VP (buildings + awards + VP cards) wins.
- Drag to rotate, scroll to zoom, right-drag to pan; hover hexes to inspect them.
- **New game** reseeds the island and restarts the draft.

## Art and finished interactions

Open `/assets/astra/kit.html` for the complete visual asset catalog. `docs/art/art-direction.md` explains the palette, typography, responsive HUD, material manifest and sound cues; `docs/art/prompts.md` records the built-in imagegen prompts.

- **Sound**: on by default. Imperial march starts when the browser permits autoplay (or on the first interaction). The transport below Around the table offers track selection, play/stop, volume, and quick March / Knight / City buttons. City builds use `starship-1.mp3`; Knights use `knight_moat3.mp3`. The header toggle mutes automatic cues.
- **Your hand**: resources and development cards stay visible together. Matching development cards are grouped with counts; newly bought cards say “Ready next turn.” Click a development card to open its actions.
- **Miniature island**: connected slate ridges, layered evergreen firs, planted wheat with seed heads, and carved gable-roof settlements and towered cities use the original island concept as their reference. Generated slate, fir and painted-wood textures live in the material manifest.
- **Board view**: drag to rotate, scroll to zoom, or use the − / compass / + controls. The compass restores the starting view. Hover over terrain or a harbor for a short guide.
- **Undo**: the last paid road, settlement or city can be undone before another action; resources and awards are restored.
- **Trades**: select one player or Anyone at the table. First acceptance completes the exchange; recipients may decline or counter.
- **Journal**: expand Voyage journal for the complete match history.
- **Road Building**: finish unused free roads before rolling without ending your turn.
- **Mobile**: the board and a scrollable HUD sheet occupy separate areas.

For online development, also run `npm run build:game` then `npm run start:game`. Docker Compose starts both services.

To avoid occupied ports, set CATAN_WEB_PORT, CATAN_GAME_PORT, and VITE_GAME_SERVER_PORT in .env (see .env.example), then rebuild. This workspace currently uses http://localhost:3011 and game port 8011.

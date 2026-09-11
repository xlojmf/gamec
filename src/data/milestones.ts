export interface Milestone {
  id: string
  title: string
  detail: string
  status: 'done' | 'next' | 'todo'
}

/** Milestone tracker — mirrors PRD.md §6. Keep both in sync. */
export const MILESTONES: Milestone[] = [
  { id: 'M0', title: 'PRD & repo', detail: 'Product doc with full rules, tooling, Docker skeleton', status: 'done' },
  { id: 'M1', title: 'Three.js project', detail: 'TanStack Start + TypeScript strict + Three.js scene shell', status: 'done' },
  { id: 'M2', title: 'Hexagonal board', detail: 'Seeded generator: 19 tiles, 54 vertices, 72 edges, 9 ports', status: 'done' },
  { id: 'M3', title: 'Terrain & resource tiles', detail: 'Procedural props, number tokens, robber, ocean', status: 'done' },
  { id: 'M4', title: 'Roads & settlements', detail: 'Build mode UI, click placement, 4 player colors (free placement)', status: 'done' },
  { id: 'M5', title: 'Camera controls', detail: 'Orbit/pan/zoom with limits, damping, intro fly-in', status: 'done' },
  { id: 'M6', title: 'Dice', detail: 'Animated 3D dice roll, 7 → robber mode (move flow)', status: 'done' },
  { id: 'M7', title: 'Resource production', detail: 'Yields, player hands, bank limits (tested)', status: 'done' },
  { id: 'M8', title: 'Player turns', detail: 'boardgame.io engine: snake draft, turn phases, robber discard/move/steal', status: 'done' },
  { id: 'M9', title: 'Building rules', detail: 'Costs, supply limits, connectivity, distance rule, city upgrade, legal-spot ghosts', status: 'done' },
  { id: 'M10', title: 'Trading', detail: 'Bank 4:1, ports 3:1/2:1, domestic trades with accept/decline', status: 'done' },
  { id: 'M11', title: 'Development cards', detail: 'Deck, restrictions, effects, longest road / largest army', status: 'done' },
  { id: 'M12', title: 'Multiplayer', detail: 'boardgame.io server, rooms, hidden hands, reconnect', status: 'done' },
  {
    id: 'M13',
    title: 'Rules refinements & resilience',
    detail:
      'Dev cards before the roll, hotseat 3–4P, reveal on game over, win on own turn, persisted rooms/matches, stall watchdog, rematch',
    status: 'done',
  },
]

export const ART_TRACK: Milestone[] = [
  { id: 'A1', title: 'Concept & mood boards', detail: 'GPT Astra island mood, palette, lighting', status: 'done' },
  { id: 'A2', title: 'World textures', detail: 'Six terrain tops and sides, water, ivory plates, walnut frame', status: 'done' },
  { id: 'A3', title: 'UI kit', detail: 'HUD panels, buttons, icons, dice, logo', status: 'done' },
  { id: 'A4', title: 'Sound design', detail: 'Dice throw, build placement, robber, trade, win fanfare', status: 'done' },
  { id: 'A5', title: 'Feel & feedback', detail: 'Placement animations, safe last-build undo, full voyage journal', status: 'done' },
  { id: 'A6', title: 'Trade negotiation', detail: 'Counter-offers, offers to multiple players at once', status: 'done' },
]

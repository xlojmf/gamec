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
  { id: 'M10', title: 'Trading', detail: 'Bank 4:1, ports, player trades', status: 'next' },
  { id: 'M11', title: 'Development cards', detail: 'Deck, restrictions, longest road / largest army', status: 'todo' },
  { id: 'M12', title: 'Multiplayer', detail: 'boardgame.io server, rooms, hidden hands, reconnect', status: 'todo' },
]

export const ART_TRACK: Milestone[] = [
  { id: 'A1', title: 'Concept & mood boards', detail: 'GPT Astra island mood, palette, lighting', status: 'next' },
  { id: 'A2', title: 'World textures', detail: 'Tile textures ×6, water, tokens, frame', status: 'todo' },
  { id: 'A3', title: 'UI kit', detail: 'HUD panels, buttons, icons, dice, logo', status: 'todo' },
]

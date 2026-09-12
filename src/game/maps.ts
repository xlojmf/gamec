/**
 * Fixed map presets — curated islands that can be chosen instead of a random
 * seed. Terrain layouts reconstructed from the official Catan World
 * Championships 2025 maps published by catancollector.com (rendered map
 * photos at /images/2025/05/06/cwc2025-map01..04.jpg).
 *
 * Number tokens follow the official A–R spiral rule (the engine assigns them
 * clockwise around the desert), and harbor placement stays seeded — the fixed
 * part of a preset is the terrain island itself. Like the published maps,
 * fixed islands may legally carry adjacent 6/8 numbers (the no-adjacent-red
 * guideline is for the variable setup only).
 */

import type { Terrain } from './terrain'

export interface MapPreset {
  id: string
  name: string
  /** Provenance shown in the room UI. */
  source: string
  /** Terrain per axial tile key `${q},${r}` — all 19 tiles of the island. */
  tiles: Record<string, Terrain>
}

export const MAP_PRESETS: MapPreset[] = [
  {
    id: 'cwc2025-1',
    name: 'World Champs 2025 · Map 1',
    source: 'Catan World Championships, Stuttgart — April 2025 (via catancollector.com)',
    tiles: {
      '-2,0': 'desert', '-2,1': 'fields', '-2,2': 'hills',
      '-1,-1': 'hills', '-1,0': 'fields', '-1,1': 'forest', '-1,2': 'fields',
      '0,-2': 'hills', '0,-1': 'mountains', '0,0': 'pasture', '0,1': 'fields', '0,2': 'forest',
      '1,-2': 'pasture', '1,-1': 'forest', '1,0': 'forest', '1,1': 'pasture',
      '2,-2': 'pasture', '2,-1': 'mountains', '2,0': 'mountains',
    },
  },
  {
    id: 'cwc2025-2',
    name: 'World Champs 2025 · Map 2',
    source: 'Catan World Championships, Stuttgart — April 2025 (via catancollector.com)',
    tiles: {
      '-2,0': 'fields', '-2,1': 'hills', '-2,2': 'pasture',
      '-1,-1': 'pasture', '-1,0': 'fields', '-1,1': 'mountains', '-1,2': 'pasture',
      '0,-2': 'hills', '0,-1': 'fields', '0,0': 'forest', '0,1': 'hills', '0,2': 'forest',
      '1,-2': 'mountains', '1,-1': 'fields', '1,0': 'forest', '1,1': 'desert',
      '2,-2': 'pasture', '2,-1': 'mountains', '2,0': 'forest',
    },
  },
  {
    id: 'cwc2025-3',
    name: 'World Champs 2025 · Map 3',
    source: 'Catan World Championships, Stuttgart — April 2025 (via catancollector.com)',
    tiles: {
      '-2,0': 'pasture', '-2,1': 'forest', '-2,2': 'fields',
      '-1,-1': 'pasture', '-1,0': 'hills', '-1,1': 'forest', '-1,2': 'forest',
      '0,-2': 'forest', '0,-1': 'hills', '0,0': 'hills', '0,1': 'mountains', '0,2': 'fields',
      '1,-2': 'desert', '1,-1': 'fields', '1,0': 'mountains', '1,1': 'pasture',
      '2,-2': 'mountains', '2,-1': 'fields', '2,0': 'pasture',
    },
  },
  {
    id: 'cwc2025-4',
    name: 'World Champs 2025 · Map 4',
    source: 'Catan World Championships, Stuttgart — April 2025 (via catancollector.com)',
    tiles: {
      '-2,0': 'mountains', '-2,1': 'desert', '-2,2': 'mountains',
      '-1,-1': 'mountains', '-1,0': 'forest', '-1,1': 'forest', '-1,2': 'fields',
      '0,-2': 'pasture', '0,-1': 'pasture', '0,0': 'hills', '0,1': 'pasture', '0,2': 'forest',
      '1,-2': 'forest', '1,-1': 'fields', '1,0': 'hills', '1,1': 'fields',
      '2,-2': 'fields', '2,-1': 'pasture', '2,0': 'hills',
    },
  },
]

/** All valid axial tile keys of the 19-hex island. */
const ISLAND_KEYS = new Set<string>()
for (let q = -2; q <= 2; q++) {
  const rMin = Math.max(-2, -q - 2)
  const rMax = Math.min(2, -q + 2)
  for (let r = rMin; r <= rMax; r++) ISLAND_KEYS.add(`${q},${r}`)
}

/** Official composition per terrain type (4/4/4/3/3/1). */
export const OFFICIAL_COUNTS: Record<Terrain, number> = {
  forest: 4, pasture: 4, fields: 4, hills: 3, mountains: 3, desert: 1,
}

/** Look up a preset by id (null for random islands). */
export function mapPresetById(id: string | null | undefined): MapPreset | null {
  if (!id) return null
  return MAP_PRESETS.find((m) => m.id === id) ?? null
}

/** True when the preset covers the island with the official composition. */
export function validatePreset(preset: MapPreset): boolean {
  const keys = Object.keys(preset.tiles)
  if (keys.length !== 19) return false
  const counts: Record<string, number> = {}
  for (const key of keys) {
    if (!ISLAND_KEYS.has(key)) return false
    const terrain = preset.tiles[key]
    counts[terrain] = (counts[terrain] ?? 0) + 1
  }
  return (Object.keys(OFFICIAL_COUNTS) as Terrain[]).every((t) => counts[t] === OFFICIAL_COUNTS[t])
}

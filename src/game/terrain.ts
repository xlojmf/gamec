/**
 * Terrain & resource definitions for the base Catan island.
 * Pure data — no framework imports allowed in this folder.
 */

export type Resource = 'wood' | 'brick' | 'grain' | 'wool' | 'ore'
export const RESOURCES: readonly Resource[] = ['wood', 'brick', 'grain', 'wool', 'ore']

export type Terrain = 'forest' | 'pasture' | 'fields' | 'hills' | 'mountains' | 'desert'

export interface TerrainInfo {
  /** Human label, e.g. "Forest — Lumber". */
  label: string
  /** Resource produced (null for desert). */
  resource: Resource | null
  /** Placeholder procedural colors; replaced by GPT Astra textures (art track A2). */
  color: number
  accent: number
}

export const TERRAIN_INFO: Record<Terrain, TerrainInfo> = {
  forest: { label: 'Forest · Lumber', resource: 'wood', color: 0x2f7d4f, accent: 0x1d5a38 },
  pasture: { label: 'Pasture · Wool', resource: 'wool', color: 0x94c95e, accent: 0x6aa83f },
  fields: { label: 'Fields · Grain', resource: 'grain', color: 0xe0be58, accent: 0xc9a23a },
  hills: { label: 'Hills · Brick', resource: 'brick', color: 0xc0683a, accent: 0x9c4f28 },
  mountains: { label: 'Mountains · Ore', resource: 'ore', color: 0x8d9099, accent: 0x6d7078 },
  desert: { label: 'Desert', resource: null, color: 0xe2d3a1, accent: 0xc9b87f },
}

/** Standard island composition: 4/4/4/3/3/1. */
export const TERRAIN_COUNTS: readonly [Terrain, number][] = [
  ['forest', 4],
  ['pasture', 4],
  ['fields', 4],
  ['hills', 3],
  ['mountains', 3],
  ['desert', 1],
]

export const RESOURCE_LABELS: Record<Resource, string> = {
  wood: 'Lumber',
  brick: 'Brick',
  grain: 'Grain',
  wool: 'Wool',
  ore: 'Ore',
}

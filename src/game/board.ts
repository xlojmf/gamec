/**
 * Hexagonal board generation for the 19-tile Catan island.
 *
 * Pure, deterministic (seed-driven) module — no React/Three imports.
 * This is the layer boardgame.io consumes (M8+).
 *
 * Geometry: pointy-top hexes with axial coordinates (q, r).
 *   world x = 1.5 * q * TILE_SIZE
 *   world z = sqrt(3) * (r + q/2) * TILE_SIZE
 * Hex corners sit at angles 60°·k with circumradius TILE_SIZE (neighbors are
 * reached through edge midpoints at 30°+60°·k). Meshes must therefore rotate
 * CylinderGeometry's default corners (30°+60°·k) by +30°: rotation.y = π/6.
 */

import { mulberry32, shuffled } from './rng'
import { mapPresetById } from './maps'
import { RESOURCES, TERRAIN_COUNTS, type Resource, type Terrain } from './terrain'

export const TILE_SIZE = 1
export const BOARD_RADIUS = 2 // rings: 1 + 6 + 12 = 19 tiles

/** Official A–R chit values in spiral placement order (no 7). */
const SPIRAL_NUMBERS = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 9, 5, 10, 11, 6, 3, 8, 4] as const

/** The six axial direction vectors for pointy-top neighbor lookups. */
const HEX_DIRS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
] as const

export function axialDistance(q: number, r: number): number {
  return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2
}

export function tileWorldPos(q: number, r: number): { x: number; z: number } {
  return {
    x: 1.5 * q * TILE_SIZE,
    z: Math.sqrt(3) * (r + q / 2) * TILE_SIZE,
  }
}

export type VertexId = string
export type EdgeId = string

export interface Tile {
  id: string
  q: number
  r: number
  x: number
  z: number
  terrain: Terrain
  /** Number token (null for the desert). */
  numberToken: number | null
  /** The 6 corner vertex ids, in angle order (30°, 90°, …). */
  vertexIds: string[]
  /** Neighbor tile ids (up to 6, island members only). */
  neighborIds: string[]
}

export interface Vertex {
  id: string
  x: number
  z: number
  /** Tiles touching this intersection (1–3). */
  tileIds: string[]
  edgeIds: string[]
  portId: string | null
}

export interface Edge {
  id: string
  vertexIds: [string, string]
  /** Tiles touching this edge (1 for boundary, 2 interior). */
  tileIds: string[]
  portId: string | null
}

export type PortKind = 'generic' | Resource

export interface Port {
  id: string
  /** 'generic' = 3:1 trade, else 2:1 for that resource. */
  kind: PortKind
  edgeId: string
  vertexIds: [string, string]
}

export interface Board {
  seed: number
  tiles: Tile[]
  vertices: Vertex[]
  edges: Edge[]
  ports: Port[]
  /** Convenience lookups. */
  tileById: Map<string, Tile>
  vertexById: Map<string, Vertex>
  edgeById: Map<string, Edge>
  /** Id of the desert tile (robber's starting home). */
  desertTileId: string
}

function vKey(x: number, z: number): string {
  // Round to 2 decimals; normalize -0 so identical points share a key.
  const kx = +(x.toFixed(2)) + 0
  const kz = +(z.toFixed(2)) + 0
  return `${kx},${kz}`
}

function eKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Generates the island:
 *  1. 19 hexes at axial distance ≤ 2 from the center.
 *  2. Terrain shuffled from the official 4/4/4/3/3/1 composition — or taken
 *     verbatim from a fixed `mapPreset` (curated tournament islands).
 *  3. Number tokens placed along the official clockwise spiral (outer ring →
 *     center), skipping the desert (official A–R chit rule).
 *  4. Fairness rule: no two red numbers (6/8) on adjacent hexes (reshuffled
 *     if violated — skipped for fixed presets, whose numbers are official).
 *  5. Vertices (54) and edges (72) deduplicated from hex corners.
 *  6. Ports (9) placed on every other boundary edge, kinds shuffled (even for
 *     fixed presets — harbor layout stays a seeded surprise).
 */
export function generateBoard(seed: number, mapPreset?: string | null): Board {
  const preset = mapPresetById(mapPreset)
  const rnd = mulberry32(seed)
  /** Exact (unrounded) corner positions, keyed by the rounded vertex id. */
  const cornerExact = new Map<string, { x: number; z: number }>()

  // ---- 1. tile coordinates -------------------------------------------------
  const coords: Array<[number, number]> = []
  for (let q = -BOARD_RADIUS; q <= BOARD_RADIUS; q++) {
    const rMin = Math.max(-BOARD_RADIUS, -q - BOARD_RADIUS)
    const rMax = Math.min(BOARD_RADIUS, -q + BOARD_RADIUS)
    for (let r = rMin; r <= rMax; r++) coords.push([q, r])
  }

  // ---- 2. terrain -----------------------------------------------------------
  const tileTerrain = new Map<string, Terrain>()
  if (preset) {
    for (const [key, terrain] of Object.entries(preset.tiles)) tileTerrain.set(key, terrain)
  } else {
    const terrainPool: Terrain[] = TERRAIN_COUNTS.flatMap(([t, n]) => Array<Terrain>(n).fill(t))
    const terrains = shuffled(terrainPool, rnd)
    coords.forEach(([q, r], i) => tileTerrain.set(`${q},${r}`, terrains[i]))
  }

  const isDesertAt = (q: number, r: number) => tileTerrain.get(`${q},${r}`) === 'desert'

  // ---- 3+4. number tokens in spiral order, red-number fairness ---------------
  // Spiral: outer ring first (sorted by angle), then ring 1, then center.
  const ringOf = (q: number, r: number) => axialDistance(q, r)
  const ordered = [...coords].sort((a, b) => {
    const ra = ringOf(a[0], a[1])
    const rb = ringOf(b[0], b[1])
    if (ra !== rb) return rb - ra // outer first
    const pa = tileWorldPos(a[0], a[1])
    const pb = tileWorldPos(b[0], b[1])
    return Math.atan2(pa.z, pa.x) - Math.atan2(pb.z, pb.x) // clockwise by angle
  })

  const areRedNeighbors = (numbers: Map<string, number | null>): boolean => {
    for (const [q, r] of coords) {
      const n = numbers.get(`${q},${r}`)
      if (n !== 6 && n !== 8) continue
      for (const [dq, dr] of HEX_DIRS) {
        const m = numbers.get(`${q + dq},${r + dr}`)
        if (m === 6 || m === 8) return true
      }
    }
    return false
  }

  let numbers = new Map<string, number | null>()
  if (preset) {
    // fixed island: the official A–R chit sequence in spiral order, one pass
    let vi = 0
    numbers = new Map(ordered.map(([q, r]) => [`${q},${r}`, isDesertAt(q, r) ? null : SPIRAL_NUMBERS[vi++]]))
  } else {
    for (let attempt = 0; attempt < 100; attempt++) {
      const values = shuffled(SPIRAL_NUMBERS, rnd)
      let vi = 0
      numbers = new Map(ordered.map(([q, r]) => [`${q},${r}`, isDesertAt(q, r) ? null : values[vi++]]))
      if (!areRedNeighbors(numbers)) break
    }
  }

  // ---- tiles -----------------------------------------------------------------
  const tiles: Tile[] = coords.map(([q, r]) => {
    const { x, z } = tileWorldPos(q, r)
    const terrain = tileTerrain.get(`${q},${r}`)!
    const vertexIds: string[] = []
    for (let k = 0; k < 6; k++) {
      const a = (60 * k * Math.PI) / 180
      const cx = x + Math.cos(a) * TILE_SIZE
      const cz = z + Math.sin(a) * TILE_SIZE
      vertexIds.push(vKey(cx, cz))
      if (!cornerExact.has(vertexIds[k])) cornerExact.set(vertexIds[k], { x: cx, z: cz })
    }
    const neighborIds = HEX_DIRS.map(([dq, dr]) => `${q + dq},${r + dr}`).filter((id) =>
      coords.some(([nq, nr]) => `${nq},${nr}` === id),
    )
    return { id: `${q},${r}`, q, r, x, z, terrain, numberToken: numbers.get(`${q},${r}`) ?? null, vertexIds, neighborIds }
  })
  const tileById = new Map(tiles.map((t) => [t.id, t]))

  // ---- 5. vertices & edges -----------------------------------------------------
  const vertexMap = new Map<string, Vertex>()
  const edgeMap = new Map<string, Edge>()

  for (const tile of tiles) {
    for (const vid of tile.vertexIds) {
      let v = vertexMap.get(vid)
      if (!v) {
        const pos = cornerExact.get(vid)!
        v = { id: vid, x: pos.x, z: pos.z, tileIds: [], edgeIds: [], portId: null }
        vertexMap.set(vid, v)
      }
      if (!v.tileIds.includes(tile.id)) v.tileIds.push(tile.id)
    }
    for (let k = 0; k < 6; k++) {
      const a = tile.vertexIds[k]
      const b = tile.vertexIds[(k + 1) % 6]
      const key = eKey(a, b)
      let e = edgeMap.get(key)
      if (!e) {
        e = { id: key, vertexIds: [a, b], tileIds: [], portId: null }
        edgeMap.set(key, e)
      }
      if (!e.tileIds.includes(tile.id)) e.tileIds.push(tile.id)
    }
  }
  const vertices = [...vertexMap.values()]
  const edges = [...edgeMap.values()]
  for (const v of vertices) {
    v.edgeIds = edges.filter((e) => e.vertexIds.includes(v.id)).map((e) => e.id)
  }

  // ---- 6. ports -----------------------------------------------------------------
  // The perimeter of a radius-2 hex island has 6·(2·2+1) = 30 boundary edges.
  // Place 9 ports spread as evenly as possible around them (mirrors the feel of
  // the physical board, which fixes port slots in the frame).
  const boundary = edges
    .filter((e) => e.tileIds.length === 1)
    .sort((a, b) => {
      const va = vertexMap.get(a.vertexIds[0])!
      const vb = vertexMap.get(b.vertexIds[0])!
      return Math.atan2(va.z, va.x) - Math.atan2(vb.z, vb.x)
    })
  const portIdx = new Set(Array.from({ length: 9 }, (_, i) => Math.round((i * boundary.length) / 9)))
  const portEdges = boundary.filter((_, i) => portIdx.has(i))
  const portKinds = shuffled<PortKind>(
    ['generic', 'generic', 'generic', 'generic', ...RESOURCES],
    rnd,
  )
  const ports: Port[] = portEdges.map((e, i) => ({
    id: `port-${i}`,
    kind: portKinds[i],
    edgeId: e.id,
    vertexIds: [...e.vertexIds],
  }))
  for (const p of ports) {
    edgeMap.get(p.edgeId)!.portId = p.id
    for (const vid of p.vertexIds) vertexMap.get(vid)!.portId = p.id
  }

  const desertTile = tiles.find((t) => t.terrain === 'desert')!

  return {
    seed,
    tiles,
    vertices,
    edges,
    ports,
    tileById,
    vertexById: vertexMap,
    edgeById: edgeMap,
    desertTileId: desertTile.id,
  }
}

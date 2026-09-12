import { describe, expect, it } from 'vitest'
import { axialDistance, generateBoard } from './board'
import { TERRAIN_COUNTS } from './terrain'

describe('generateBoard', () => {
  const board = generateBoard(12345)

  it('creates the 19-tile island with the official terrain composition', () => {
    expect(board.tiles).toHaveLength(19)
    for (const [terrain, count] of TERRAIN_COUNTS) {
      expect(board.tiles.filter((t) => t.terrain === terrain)).toHaveLength(count)
    }
    expect(board.ports).toHaveLength(9)
    expect(board.ports.filter((p) => p.kind === 'generic')).toHaveLength(4)
  })

  it('has exactly 54 vertices and 72 edges', () => {
    expect(board.vertices).toHaveLength(54)
    expect(board.edges).toHaveLength(72)
  })

  it('places the 18 number tokens on non-desert tiles only', () => {
    const tokens = board.tiles.map((t) => t.numberToken).filter((n): n is number => n !== null)
    expect(tokens).toHaveLength(18)
    expect(board.tiles.find((t) => t.id === board.desertTileId)!.numberToken).toBeNull()
    const sorted = [...tokens].sort((a, b) => a - b)
    expect(sorted).toEqual([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12])
  })

  it('never puts two red numbers (6/8) on adjacent tiles', () => {
    for (const tile of board.tiles) {
      if (tile.numberToken !== 6 && tile.numberToken !== 8) continue
      for (const nid of tile.neighborIds) {
        const n = board.tileById.get(nid)!
        expect([6, 8]).not.toContain(n.numberToken)
      }
    }
  })

  it('builds a consistent topology (edge lengths, vertex degrees)', () => {
    for (const e of board.edges) {
      const [a, b] = e.vertexIds.map((id) => board.vertexById.get(id)!)
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      const len = Math.hypot(a.x - b.x, a.z - b.z)
      expect(len).toBeCloseTo(1, 2) // side length == circumradius for regular hexes
      expect(e.tileIds.length).toBeGreaterThanOrEqual(1)
      expect(e.tileIds.length).toBeLessThanOrEqual(2)
    }
    for (const v of board.vertices) {
      expect(v.tileIds.length).toBeGreaterThanOrEqual(1)
      expect(v.tileIds.length).toBeLessThanOrEqual(3)
      expect(v.edgeIds.length).toBeGreaterThanOrEqual(2)
      expect(v.edgeIds.length).toBeLessThanOrEqual(3)
    }
  })

  it('keeps every tile ring at the right distance', () => {
    for (const t of board.tiles) {
      expect(axialDistance(t.q, t.r)).toBeLessThanOrEqual(2)
    }
    expect(board.tiles.filter((t) => axialDistance(t.q, t.r) === 0)).toHaveLength(1)
    expect(board.tiles.filter((t) => axialDistance(t.q, t.r) === 1)).toHaveLength(6)
    expect(board.tiles.filter((t) => axialDistance(t.q, t.r) === 2)).toHaveLength(12)
  })

  it('is deterministic for a given seed', () => {
    const again = generateBoard(12345)
    expect(again.tiles.map((t) => [t.id, t.terrain, t.numberToken])).toEqual(
      board.tiles.map((t) => [t.id, t.terrain, t.numberToken]),
    )
    expect(again.ports.map((p) => [p.edgeId, p.kind])).toEqual(board.ports.map((p) => [p.edgeId, p.kind]))
  })

  it('assigns every port to a boundary edge with exactly 2 vertices', () => {
    for (const p of board.ports) {
      const e = board.edgeById.get(p.edgeId)!
      expect(e.tileIds).toHaveLength(1)
      expect(p.vertexIds).toHaveLength(2)
      for (const vid of p.vertexIds) {
        expect(board.vertexById.get(vid)!.portId).toBe(p.id)
      }
    }
  })
})

// -- fixed map presets ----------------------------------------------------------

import { MAP_PRESETS } from './maps'

describe('generateBoard with a fixed preset', () => {
  it('places the preset terrain verbatim (any seed)', () => {
    for (const preset of MAP_PRESETS) {
      const board = generateBoard(42, preset.id)
      for (const tile of board.tiles) {
        expect(tile.terrain).toBe(preset.tiles[tile.id])
      }
      expect(board.desertTileId).toBeTruthy()
      expect(board.tileById.get(board.desertTileId)!.terrain).toBe('desert')
    }
  })

  it('follows the official A–R chit spiral, skipping the desert', () => {
    const SPIRAL = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 9, 5, 10, 11, 6, 3, 8, 4]
    for (const preset of MAP_PRESETS) {
      const board = generateBoard(7, preset.id)
      const producing = board.tiles.filter((t) => t.terrain !== 'desert')
      expect(producing).toHaveLength(18)
      // the multiset of numbers is exactly the official sequence
      const numbers = producing.map((t) => t.numberToken).sort((a, b) => a! - b!)
      expect(numbers).toEqual([...SPIRAL].sort((a, b) => a - b))
      // desert has no token
      expect(board.tileById.get(board.desertTileId)!.numberToken).toBeNull()
      // NOTE: adjacent 6/8 can legitimately appear on fixed islands — the
      // no-adjacent-red guideline governs the variable (random) setup only,
      // and some official maps (e.g. CWC 2025 #1/#3) break it by design.
    }
  })

  it('is deterministic for a given seed + preset, and differs between presets', () => {
    const a = generateBoard(99, 'cwc2025-1')
    const b = generateBoard(99, 'cwc2025-1')
    expect(a.tiles.map((t) => [t.id, t.terrain, t.numberToken])).toEqual(
      b.tiles.map((t) => [t.id, t.terrain, t.numberToken]),
    )
    const c = generateBoard(99, 'cwc2025-2')
    expect(a.tiles.map((t) => t.terrain)).not.toEqual(c.tiles.map((t) => t.terrain))
  })

  it('unknown preset ids fall back to a random island', () => {
    const board = generateBoard(5, 'does-not-exist')
    expect(board.tiles).toHaveLength(19)
  })
})

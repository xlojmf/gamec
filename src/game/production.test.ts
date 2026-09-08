import { describe, expect, it } from 'vitest'
import { generateBoard } from './board'
import { BANK_START, computeProduction, type Building } from './production'
import { RESOURCES, TERRAIN_INFO, type ResourceCounts } from './terrain'

const board = generateBoard(2024)

/** First tile of a terrain that carries a number token (never the desert). */
function producingTile(terrain: 'forest' | 'fields' | 'pasture' | 'hills' | 'mountains') {
  const tile = board.tiles.find((t) => t.terrain === terrain && t.numberToken !== null)
  if (!tile) throw new Error(`no producing ${terrain} tile on seed 2024`)
  return tile
}

function buildings(entries: [string, Building][]) {
  return new Map(entries)
}

const NO_ROBBER = 'not-on-this-board'

describe('computeProduction', () => {
  it('pays settlements 1 card and cities 2 cards, draining the bank', () => {
    const tile = producingTile('forest')
    const roll = tile.numberToken!
    const vertices = buildings([
      [tile.vertexIds[0], { player: 0, type: 'settlement' }],
      [tile.vertexIds[1], { player: 1, type: 'city' }],
    ])
    const r = computeProduction(board, vertices, NO_ROBBER, roll, BANK_START)

    expect(r.gains[0].wood).toBe(1)
    expect(r.gains[1].wood).toBe(2)
    expect(r.gains[2].wood).toBe(0)
    expect(r.bank.wood).toBe(19 - 3)
    expect(r.producingTileIds).toContain(tile.id)
    expect(r.shortages).toEqual([])
  })

  it('the robber blocks the hex he stands on', () => {
    const tile = producingTile('forest')
    const vertices = buildings([[tile.vertexIds[0], { player: 0, type: 'settlement' }]])
    const r = computeProduction(board, vertices, tile.id, tile.numberToken!, BANK_START)

    expect(r.gains.every((g) => RESOURCES.every((res) => g[res] === 0))).toBe(true)
    expect(r.bank).toEqual(BANK_START)
    expect(r.producingTileIds).not.toContain(tile.id)
  })

  it('a 7 produces nothing', () => {
    const tile = producingTile('fields')
    const vertices = buildings([[tile.vertexIds[0], { player: 2, type: 'city' }]])
    const r = computeProduction(board, vertices, NO_ROBBER, 7, BANK_START)

    expect(r.gains.every((g) => RESOURCES.every((res) => g[res] === 0))).toBe(true)
    expect(r.bank).toEqual(BANK_START)
    expect(r.producingTileIds).toEqual([])
  })

  it('a number nobody owns produces nothing', () => {
    // pick a roll that no placed building touches: settle on one tile, roll another's number
    const a = producingTile('hills')
    const b = producingTile('mountains')
    if (a.numberToken === b.numberToken) return // same chit — skip rather than flake
    const vertices = buildings([[a.vertexIds[0], { player: 0, type: 'settlement' }]])
    const r = computeProduction(board, vertices, NO_ROBBER, b.numberToken!, BANK_START)
    expect(r.gains[0].brick).toBe(0)
  })

  it('sequential payout: an exhausted stack denies later builders', () => {
    const tile = producingTile('fields')
    const vertices = buildings([
      [tile.vertexIds[0], { player: 0, type: 'settlement' }],
      [tile.vertexIds[1], { player: 1, type: 'settlement' }],
      [tile.vertexIds[2], { player: 2, type: 'settlement' }],
    ])
    const bank: ResourceCounts = { ...BANK_START, grain: 2 }
    const r = computeProduction(board, vertices, NO_ROBBER, tile.numberToken!, bank)

    expect(r.gains[0].grain).toBe(1)
    expect(r.gains[1].grain).toBe(1)
    expect(r.gains[2].grain).toBe(0) // stack empty → nothing
    expect(r.bank.grain).toBe(0)
    expect(r.shortages).toContain('grain')
  })

  it('a city partially pays out when it drains the last card', () => {
    const tile = producingTile('forest')
    const vertices = buildings([[tile.vertexIds[0], { player: 1, type: 'city' }]])
    const bank: ResourceCounts = { ...BANK_START, wood: 1 }
    const r = computeProduction(board, vertices, NO_ROBBER, tile.numberToken!, bank)

    expect(r.gains[1].wood).toBe(1)
    expect(r.bank.wood).toBe(0)
    expect(r.shortages).toContain('wood')
  })

  it('a shared vertex collects from every producing neighbor across rolls', () => {
    // interior vertex touching 3 tiles — place one settlement there
    const vertex = board.vertices.find((v) => v.tileIds.length === 3)!
    const tiles = vertex.tileIds
      .map((id) => board.tileById.get(id)!)
      .filter((t) => t.numberToken !== null && TERRAIN_INFO[t.terrain].resource !== null)

    const a = tiles[0]
    const b = tiles[1]
    const vertices = buildings([[vertex.id, { player: 0, type: 'settlement' }]])

    const r1 = computeProduction(board, vertices, NO_ROBBER, a.numberToken!, BANK_START)
    const r2 = computeProduction(board, vertices, NO_ROBBER, b.numberToken!, r1.bank)

    const total =
      RESOURCES.reduce((n, res) => n + r1.gains[0][res], 0) +
      RESOURCES.reduce((n, res) => n + r2.gains[0][res], 0)
    expect(total).toBe(2) // one card per producing neighboring hex
  })

  it('same player stacking a settlement and city on one tile collects 3', () => {
    const tile = producingTile('pasture')
    const vertices = buildings([
      [tile.vertexIds[0], { player: 3, type: 'settlement' }],
      [tile.vertexIds[3], { player: 3, type: 'city' }],
    ])
    const r = computeProduction(board, vertices, NO_ROBBER, tile.numberToken!, BANK_START)
    expect(r.gains[3].wool).toBe(3)
  })
})

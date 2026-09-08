/**
 * Resource production — pure yield calculation (PRD §5.3.1).
 *
 * Roll → every hex whose number token matches pays out to adjacent buildings:
 * settlement = 1 card, city = 2 cards. The robber's hex produces nothing.
 *
 * Bank limits: 19 cards per resource. Cards are paid out sequentially (tile
 * vertex angle order, players in vertex order) — once a stack is exhausted,
 * anyone who would still draw from it gets nothing (PRD empty-stack rule).
 */

import type { Board, VertexId } from './board'
import { emptyResourceCounts, TERRAIN_INFO, type Resource, type ResourceCounts } from './terrain'
import { isRobberRoll } from './dice'

export interface Building {
  player: number
  type: 'settlement' | 'city'
}

/** The bank starts with 19 of every resource (base game). */
export const BANK_START: ResourceCounts = { wood: 19, brick: 19, grain: 19, wool: 19, ore: 19 }

export interface ProductionResult {
  /** Per-player payout (index = player). */
  gains: ResourceCounts[]
  /** Bank stock remaining after the payout. */
  bank: ResourceCounts
  /** Tiles that produced (for the board highlight pulse). */
  producingTileIds: string[]
  /** Resources whose stack ran out mid-payout (at least one builder denied). */
  shortages: Resource[]
}

export function computeProduction(
  board: Board,
  vertices: ReadonlyMap<VertexId, Building>,
  robberTileId: string | null,
  rollSum: number,
  bank: ResourceCounts = { ...BANK_START },
  playerCount = 4,
): ProductionResult {
  const gains: ResourceCounts[] = Array.from({ length: playerCount }, emptyResourceCounts)
  const remaining: ResourceCounts = { ...bank }
  const shortages = new Set<Resource>()
  const producingTileIds: string[] = []

  // a 7 never produces (no token shows 7 either — belt & braces)
  if (isRobberRoll(rollSum)) return { gains, bank: remaining, producingTileIds, shortages: [] }

  for (const tile of board.tiles) {
    if (tile.numberToken !== rollSum || tile.id === robberTileId) continue
    const resource = TERRAIN_INFO[tile.terrain].resource
    if (!resource) continue // desert never produces
    producingTileIds.push(tile.id)

    for (const vertexId of tile.vertexIds) {
      const building = vertices.get(vertexId)
      if (!building) continue
      const wanted = building.type === 'city' ? 2 : 1
      const paid = Math.min(wanted, remaining[resource])
      if (paid < wanted) shortages.add(resource)
      gains[building.player][resource] += paid
      remaining[resource] -= paid
    }
  }

  return { gains, bank: remaining, producingTileIds, shortages: [...shortages] }
}

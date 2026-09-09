/**
 * Special awards — Longest Road & Largest Army (PRD §5.5).
 *
 * Pure module, no framework imports. Longest Road is a DFS over the player's
 * own edges: a path may run through any junction (empty or own building) but
 * is severed by an opponent's settlement/city — the same junction rule the
 * road-placement validator uses.
 */

import type { Board, EdgeId, VertexId } from './board'

/** Minimal building shapes so catan.ts can pass `G.buildings` directly. */
export interface AwardsBuildings {
  vertices: Record<VertexId, { player: number; type: string }>
  edges: Record<EdgeId, { player: number }>
}

export interface Award {
  player: number
  size: number
}

export const LONGEST_ROAD_MIN = 5
export const LARGEST_ARMY_MIN = 3

/**
 * Longest continuous road chain of `player`, in edges. A chain breaks at a
 * junction holding an opponent's building (own buildings and empty junctions
 * are passable), and no edge may be used twice within one chain.
 */
export function longestRoadLength(
  buildings: AwardsBuildings,
  board: Board,
  player: number,
): number {
  // own edges per vertex
  const ownEdges = new Map<VertexId, EdgeId[]>()
  for (const [eid, spot] of Object.entries(buildings.edges)) {
    if (spot.player !== player) continue
    const edge = board.edgeById.get(eid)
    if (!edge) continue
    for (const vid of edge.vertexIds) {
      let list = ownEdges.get(vid)
      if (!list) ownEdges.set(vid, (list = []))
      list.push(eid)
    }
  }

  const blocked = (vid: VertexId) => {
    const b = buildings.vertices[vid]
    return !!b && b.player !== player
  }

  /** Best extension from endpoint `vid` without reusing edges in `visited`. */
  const extend = (vid: VertexId, visited: Set<EdgeId>): number => {
    if (blocked(vid)) return 0 // an opponent's building ends the chain here
    let best = 0
    for (const eid of ownEdges.get(vid) ?? []) {
      if (visited.has(eid)) continue
      const edge = board.edgeById.get(eid)!
      const next = edge.vertexIds.find((v) => v !== vid)!
      visited.add(eid)
      best = Math.max(best, 1 + extend(next, visited))
      visited.delete(eid)
    }
    return best
  }

  let longest = 0
  for (const eid of Object.keys(buildings.edges)) {
    if (buildings.edges[eid].player !== player) continue
    const edge = board.edgeById.get(eid)
    if (!edge) continue
    const [a, b] = edge.vertexIds
    // try this edge as the starting (endpoint) edge in both orientations
    longest = Math.max(
      longest,
      1 + extend(b, new Set([eid])),
      1 + extend(a, new Set([eid])),
    )
  }
  return longest
}

/**
 * Award assignment from per-player metrics (road lengths / knight counts):
 * nobody below `threshold` qualifies; the holder keeps ties; a contender
 * needs to strictly exceed the current holder's metric to take the award.
 * Returns null when no one qualifies (e.g. the holder was cut below the
 * threshold and nobody else reaches it).
 */
export function claimAward(
  current: Award | null,
  metric: number[],
  threshold: number,
): Award | null {
  let best: Award | null = null
  for (let p = 0; p < metric.length; p++) {
    if (metric[p] < threshold) continue
    if (!best || metric[p] > best.size) best = { player: p, size: metric[p] }
  }
  if (!best) return null
  if (current && metric[current.player] >= threshold && metric[current.player] === best.size) {
    return { player: current.player, size: metric[current.player] }
  }
  return best
}

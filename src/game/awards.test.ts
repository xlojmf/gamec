import { describe, expect, it } from 'vitest'
import { claimAward, longestRoadLength, LONGEST_ROAD_MIN, type AwardsBuildings } from './awards'
import { generateBoard, type Board, type EdgeId, type VertexId } from './board'

const board: Board = generateBoard(7)

/** Build a buildings record from a drawn list of edges (as vertex pairs). */
function buildingsFrom(
  edges: Array<[VertexId, VertexId, number]>,
  vertices: Array<[VertexId, { player: number; type: string }]> = [],
): AwardsBuildings {
  const b: AwardsBuildings = { vertices: {}, edges: {} }
  for (const [a, c, player] of edges) {
    b.edges[`${a}|${c}`.split('|').sort().join('|')] = { player }
  }
  for (const [vid, v] of vertices) b.vertices[vid] = v
  return b
}

/** Vertices along a straight line of `n` edges on the board's edge graph. */
function pathVertices(n: number): VertexId[] {
  // walk from an arbitrary vertex along unused edges
  const start = board.vertices.find((v) => v.edgeIds.length === 3)!
  const out: VertexId[] = [start.id]
  const used = new Set<EdgeId>()
  while (out.length <= n) {
    const cur = board.vertexById.get(out[out.length - 1])!
    const next = cur.edgeIds
      .map((eid) => board.edgeById.get(eid)!)
      .find((e) => !used.has(e.id) && !out.includes(e.vertexIds.find((v) => v !== cur.id)!))
    if (!next) break
    used.add(next.id)
    out.push(next.vertexIds.find((v) => v !== cur.id)!)
  }
  return out
}

function edgeIdsBetween(vs: VertexId[]): Array<[VertexId, VertexId, number]> {
  const out: Array<[VertexId, VertexId, number]> = []
  for (let i = 0; i + 1 < vs.length; i++) out.push([vs[i], vs[i + 1], 0])
  return out
}

describe('longestRoadLength', () => {
  it('counts a straight chain and ignores other players\' roads', () => {
    const vs = pathVertices(6) // 6 edges
    const b = buildingsFrom(edgeIdsBetween(vs.slice(0, 6))) // first 5 edges are player 0's
    expect(longestRoadLength(b, board, 0)).toBe(5)

    // opponent roads don't help
    const b2 = buildingsFrom(
      edgeIdsBetween(vs.slice(0, 4)).concat(
        edgeIdsBetween(vs.slice(4, 7)).map(([a, c]) => [a, c, 1] as [VertexId, VertexId, number]),
      ),
    )
    expect(longestRoadLength(b2, board, 0)).toBe(3)
  })

  it('picks the longest branch at a fork', () => {
    const center = board.vertices.find((v) => v.edgeIds.length === 3)!
    const branches = center.edgeIds.map((eid) =>
      board.edgeById.get(eid)!.vertexIds.find((v) => v !== center.id)!,
    )
    // center→branch edges (3) plus a 2-edge extension on branch 0 and 1-edge on branch 1
    const ext0 = board.vertexById.get(branches[0])!
    const ext0next = ext0.edgeIds
      .map((eid) => board.edgeById.get(eid)!)
      .find((e) => !e.vertexIds.includes(center.id))!
      .vertexIds.find((v) => v !== branches[0])!
    const ext1 = board.vertexById.get(branches[1])!
    const ext1next = ext1.edgeIds
      .map((eid) => board.edgeById.get(eid)!)
      .find((e) => !e.vertexIds.includes(center.id))!
      .vertexIds.find((v) => v !== branches[1])!

    const b = buildingsFrom([
      [center.id, branches[0], 0],
      [center.id, branches[1], 0],
      [center.id, branches[2], 0],
      [branches[0], ext0next, 0],
      [branches[1], ext1next, 0],
    ])
    // best chain: ext1next—branches[1]—center—branches[0]—ext0next = 4
    expect(longestRoadLength(b, board, 0)).toBe(4)
  })

  it("an opponent's building severs the chain at that junction", () => {
    const vs = pathVertices(7) // 7 edges: a-b-c-d-e-f-g-h
    const roads = edgeIdsBetween(vs)
    const b = buildingsFrom(roads, [[vs[4], { player: 1, type: 'settlement' }]]) // building mid-chain
    // chains: a..e (4) and e..h (3) — cannot pass through the blocked junction
    expect(longestRoadLength(b, board, 0)).toBe(4)
  })

  it("an own building doesn't sever the chain", () => {
    const vs = pathVertices(5)
    const b = buildingsFrom(edgeIdsBetween(vs), [[vs[2], { player: 0, type: 'settlement' }]])
    expect(longestRoadLength(b, board, 0)).toBe(5)
  })

  it('a closed ring counts every edge once', () => {
    // find a hex and use its 6 boundary edges
    const tile = board.tiles.find((t) => t.vertexIds.length === 6)!
    const ring: Array<[VertexId, VertexId, number]> = []
    for (let k = 0; k < 6; k++) {
      ring.push([tile.vertexIds[k], tile.vertexIds[(k + 1) % 6], 0])
    }
    const b = buildingsFrom(ring)
    expect(longestRoadLength(b, board, 0)).toBe(6)
  })
})

describe('claimAward', () => {
  it('needs the threshold, transfers only on strictly exceeding, keeps holder ties', () => {
    expect(claimAward(null, [4, 4, 4, 4], LONGEST_ROAD_MIN)).toBeNull()
    expect(claimAward(null, [5, 4, 0, 0], 5)).toEqual({ player: 0, size: 5 })

    // holder (0) keeps the tie at 5 vs a new 5
    expect(claimAward({ player: 0, size: 5 }, [5, 5, 0, 0], 5)).toEqual({ player: 0, size: 5 })
    // contender must exceed: 5 vs 5 keeps holder
    expect(claimAward({ player: 1, size: 5 }, [5, 5, 0, 0], 5)).toEqual({ player: 1, size: 5 })
    // strict exceed takes it
    expect(claimAward({ player: 0, size: 5 }, [5, 6, 0, 0], 5)).toEqual({ player: 1, size: 6 })
    // holder grows
    expect(claimAward({ player: 0, size: 5 }, [7, 6, 0, 0], 5)).toEqual({ player: 0, size: 7 })
    // holder cut below threshold → best qualifier takes over
    expect(claimAward({ player: 0, size: 5 }, [3, 5, 0, 0], 5)).toEqual({ player: 1, size: 5 })
    // nobody qualifies → released
    expect(claimAward({ player: 0, size: 6 }, [2, 2, 2, 2], 5)).toBeNull()
  })

  it('largest army metrics work the same', () => {
    expect(claimAward(null, [0, 3, 0, 0], 3)).toEqual({ player: 1, size: 3 })
  })
})

import { describe, expect, it } from 'vitest'
import { Client } from 'boardgame.io/client'
import {
  _internals,
  createCatanGame,
  validSetupEdges,
  validSetupVertices,
  vpCounts,
  type BgioState,
  type GameState,
} from './catan'
import { generateBoard } from './board'
import { emptyResourceCounts, totalCards } from './terrain'

// -- test client helpers --------------------------------------------------------

function makeClient(seed = 7, rngSeed = 'test') {
  // `seed` (rng determinism) is supported at runtime but missing from 0.50 types
  const opts = { game: createCatanGame(seed), numPlayers: 4, seed: rngSeed } as unknown as Parameters<typeof Client>[0]
  const client = Client(opts)
  client.start()
  return client
}

function state(client: ReturnType<typeof makeClient>): BgioState {
  const s = client.getState() as BgioState | null
  if (!s) throw new Error('no state')
  return s
}

function asPlayer(client: ReturnType<typeof makeClient>, pid: number | string) {
  client.updatePlayerID(String(pid))
}

/** Place a full snake draft using the first valid spot each turn. */
function runSetup(client: ReturnType<typeof makeClient>) {
  const secondVertices: (string | null)[] = [null, null, null, null] // player → 2nd settlement vertex
  for (let i = 0; i < 8; i++) {
    const { G, ctx } = state(client)
    const player = Number(ctx.currentPlayer)
    const vertex = validSetupVertices(G)[0]
    const edge = validSetupEdges(G, vertex)[0]
    asPlayer(client, player)
    client.moves.placeSetup(vertex, edge)
    if (i >= 4) secondVertices[player] = vertex
  }
  return secondVertices
}

// -- integration: full flow through a real boardgame.io client -------------------

describe('CatanGame setup phase', () => {
  it('runs the snake draft 0,1,2,3,3,2,1,0 then starts main at player 0', () => {
    const client = makeClient(7)
    const order: number[] = []
    for (let i = 0; i < 8; i++) {
      order.push(Number(state(client).ctx.currentPlayer))
      const { G, ctx } = state(client)
      const v = validSetupVertices(G)[0]
      const e = validSetupEdges(G, v)[0]
      asPlayer(client, ctx.currentPlayer)
      client.moves.placeSetup(v, e)
    }
    expect(order).toEqual([0, 1, 2, 3, 3, 2, 1, 0])

    const s = state(client)
    expect(s.G.setupPlacements).toBe(8)
    expect(s.ctx.phase).toBe('main')
    expect(s.ctx.currentPlayer).toBe('0')
    expect(s.G.rolled).toBe(false)
  })

  it('rejects setup placements that violate the distance rule or connection', () => {
    const client = makeClient(7)
    const board = generateBoard(7)
    const { G } = state(client)
    const v0 = validSetupVertices(G)[0]
    asPlayer(client, 0)
    client.moves.placeSetup(v0, validSetupEdges(G, v0)[0]) // legal first placement
    expect(state(client).G.setupPlacements).toBe(1)

    // player 1 tries a vertex adjacent to v0 → blocked by the distance rule
    const adjacent = board.vertexById
      .get(v0)!
      .edgeIds.map((eid) => board.edgeById.get(eid)!.vertexIds.find((id) => id !== v0)!)
      .find((id) => !state(client).G.buildings.vertices[id])!
    asPlayer(client, 1)
    client.moves.placeSetup(adjacent, board.vertexById.get(adjacent)!.edgeIds[0])
    expect(state(client).G.setupPlacements).toBe(1) // rejected

    // a road not touching its settlement is rejected too
    const vFree = validSetupVertices(state(client).G)[0]
    const farEdge = board.edges.find((e) => !e.vertexIds.includes(vFree))!.id
    client.moves.placeSetup(vFree, farEdge)
    expect(state(client).G.setupPlacements).toBe(1) // rejected
  })

  it('second-round settlements grant starting resources from adjacent hexes', () => {
    const client = makeClient(7)
    const secondVertices = runSetup(client)
    const { G } = state(client)
    const board = generateBoard(7)

    let expectedCards = 0
    for (let p = 0; p < 4; p++) {
      const vertex = board.vertexById.get(secondVertices[p]!)!
      const producing = vertex.tileIds.filter((tid) => {
        const tile = board.tileById.get(tid)!
        return tile.numberToken !== null
      })
      expectedCards += producing.length
      expect(totalCards(G.hands[p])).toBe(producing.length)
    }
    expect(expectedCards).toBeGreaterThan(0)
    // cards came out of the bank
    const bankTotal = Object.values(G.bank).reduce((a, b) => a + b, 0)
    expect(bankTotal).toBe(19 * 5 - expectedCards)
  })
})

describe('CatanGame main phase', () => {
  it('roll produces into hands and keeps bank + hands conserved', () => {
    const client = makeClient(11)
    runSetup(client)
    const before = state(client).G
    const bankBefore = Object.values(before.bank).reduce((a, b) => a + b, 0)
    const handsBefore = before.hands.reduce((a, h) => a + totalCards(h), 0)

    asPlayer(client, 0)
    client.moves.roll()
    const after = state(client).G

    expect(after.rolled).toBe(true)
    expect(after.lastRoll).not.toBeNull()
    expect(after.lastRoll!.sum).toBe(after.lastRoll!.die1 + after.lastRoll!.die2)
    const bankAfter = Object.values(after.bank).reduce((a, b) => a + b, 0)
    const handsAfter = after.hands.reduce((a, h) => a + totalCards(h), 0)
    expect(bankAfter + handsAfter).toBe(bankBefore + handsBefore)

    // producing tiles match the roll and exclude the robber's hex
    const board = generateBoard(11)
    const expected = board.tiles
      .filter((t) => t.numberToken === after.lastRoll!.sum && t.id !== after.robberTileId)
      .map((t) => t.id)
    expect(after.lastProduction!.tileIds).toEqual(expected)
  })

  it('cannot act before rolling; end turn passes to the next player', () => {
    const client = makeClient(11)
    runSetup(client)
    asPlayer(client, 0)

    const { G } = state(client)
    const anyVertex = generateBoard(11).vertices.find((vx) => !G.buildings.vertices[vx.id])!.id
    client.moves.placeSettlement(anyVertex)
    expect(state(client).G.rolled).toBe(false)
    client.moves.endTurn()
    expect(state(client).ctx.currentPlayer).toBe('0') // still player 0's turn

    client.moves.roll()
    // rejected moves advance bgio's rng, so the roll may be a 7 — resolve the robber if so
    if (state(client).G.robberStep) {
      const board = generateBoard(11)
      const s = state(client)
      client.moves.moveRobber(board.tiles.find((t) => t.id !== s.G.robberTileId)!.id)
      const after = state(client)
      if (after.G.robberStep === 'steal') client.moves.steal(after.G.stealTargets![0])
    }
    client.moves.endTurn()
    expect(state(client).ctx.currentPlayer).toBe('1')
    expect(state(client).G.rolled).toBe(false) // reset for the new turn
  })

  it('builds are attributed to the active player only', () => {
    const client = makeClient(11)
    runSetup(client)
    asPlayer(client, 0)
    client.moves.roll()
    const { G } = state(client)
    const board = generateBoard(11)
    const vertex = board.vertices.find((vx) => !G.buildings.vertices[vx.id])!.id
    const edge = board.edges.find((e) => !G.buildings.edges[e.id])!.id
    client.moves.placeSettlement(vertex)
    client.moves.placeRoad(edge)
    const after = state(client).G
    expect(after.buildings.vertices[vertex]).toEqual({ player: 0, type: 'settlement' })
    expect(after.buildings.edges[edge]).toEqual({ player: 0 })

    // player 1 cannot build during player 0's turn
    asPlayer(client, 1)
    const v2 = board.vertices.find((vx) => !after.buildings.vertices[vx.id])!.id
    client.moves.placeSettlement(v2)
    expect(state(client).G.buildings.vertices[v2]).toBeUndefined()
  })

  it('a 7 opens the robber flow (discard → move → done) and blocks the turn until resolved', () => {
    const client = makeClient(11, 'seven-seeker')
    runSetup(client)

    // roll (and end turns) until a 7 shows up — rng is seeded, so this terminates
    let guard = 0
    while (state(client).G.lastRoll?.sum !== 7 && guard++ < 300) {
      asPlayer(client, state(client).ctx.currentPlayer)
      client.moves.roll()
      if (state(client).G.robberStep) break
      client.moves.endTurn()
    }
    let s = state(client)
    expect(s.G.lastRoll!.sum).toBe(7)
    expect(['discard', 'move']).toContain(s.G.robberStep)

    // if anyone held >7 cards, resolve every discard first
    if (s.G.robberStep === 'discard') {
      let pending = { ...s.G.pendingDiscards }
      while (Object.keys(pending).length > 0) {
        for (const [pidStr, required] of Object.entries(pending)) {
          const pid = Number(pidStr)
          const hand = state(client).G.hands[pid]
          const cards: Record<string, number> = {}
          let left = required as number
          for (const r of ['wood', 'brick', 'grain', 'wool', 'ore'] as const) {
            const take = Math.min(left, hand[r])
            cards[r] = take
            left -= take
          }
          expect(left).toBe(0) // always enough cards to discard
          asPlayer(client, pid)
          client.moves.discardHalf(cards)
        }
        pending = { ...state(client).G.pendingDiscards }
      }
      s = state(client)
      expect(s.G.robberStep).toBe('move')
    }

    // turn cannot end while the robber is unresolved
    const mover = Number(s.ctx.currentPlayer)
    asPlayer(client, mover)
    client.moves.endTurn()
    expect(state(client).ctx.currentPlayer).toBe(String(mover))

    // move the robber; steal resolution must complete (auto if 0/1 victims)
    const board = generateBoard(11)
    const target = board.tiles.find((t) => t.id !== s.G.robberTileId)!
    client.moves.moveRobber(target.id)
    const afterMove = state(client)
    if (afterMove.G.robberStep === 'steal') {
      client.moves.steal(afterMove.G.stealTargets![0])
    }
    expect(state(client).G.robberStep).toBeNull()
    client.moves.endTurn()
    expect(Number(state(client).ctx.currentPlayer)).toBe((mover + 1) % 4)
  })
})

// -- unit tests for the robber helpers -------------------------------------------

function fakeG(hands: number[][]): GameState {
  const client = makeClient(3)
  runSetup(client)
  // bgio freezes its state — clone so tests can mutate freely
  const G = structuredClone(state(client).G)
  const allHands = hands.length > 0 ? hands : [[], [], [], []]
  G.hands = allHands.map((counts) => {
    const h = emptyResourceCounts()
    const order = ['wood', 'brick', 'grain', 'wool', 'ore'] as const
    counts.forEach((n, i) => (h[order[i]] = n))
    return h
  })
  return G
}

describe('robber helpers', () => {
  it('discard math: players with >7 cards discard floor(total/2)', () => {
    const G = fakeG([
      [8, 0, 0, 0, 0], // 8 cards → discard 4
      [3, 3, 3, 0, 0], // 9 cards → discard 4
      [2, 0, 0, 0, 0], // 2 cards → no discard
      [4, 4, 0, 0, 0], // 8 → 4
    ])
    const spy = fnSpy()
    _internals.beginRobberFlow(G, fakeEvents({ setActivePlayers: spy.fn }))
    expect(G.robberStep).toBe('discard')
    expect(G.pendingDiscards).toEqual({ 0: 4, 1: 4, 3: 4 })
    expect(spy.calls.length).toBe(1)
  })

  it('no discarders → straight to robber move', () => {
    const G = fakeG([
      [1, 0, 0, 0, 0],
      [0, 2, 0, 0, 0],
      [7, 0, 0, 0, 0], // exactly 7 → safe
      [0, 0, 0, 0, 0],
    ])
    _internals.beginRobberFlow(G, fakeEvents({}))
    expect(G.robberStep).toBe('move')
    expect(G.pendingDiscards).toEqual({})
  })

  it('steal moves exactly one random card from victim to thief', () => {
    // victim (player 1) holds 2 wood + 1 wool; die(1) always picks the pool's first card
    const G = fakeG([
      [0, 0, 0, 0, 0], // thief
      [2, 1, 0, 0, 0], // victim: 2 wood, 1 wool
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ])
    const card = _internals.doSteal(G, 1, 0, () => 1) // pool [wood, wood, wool] → wood
    expect(card).toBe('wood')
    expect(G.hands[1].wood).toBe(1)
    expect(G.hands[0].wood).toBe(1)
    expect(totalCards(G.hands[0]) + totalCards(G.hands[1])).toBe(3) // conserved
  })

  it('stealing from an empty hand is a no-op', () => {
    const G = fakeG([
      [1, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ])
    expect(_internals.doSteal(G, 1, 0, () => 1)).toBeNull()
    expect(totalCards(G.hands[0])).toBe(1)
  })
})

describe('vpCounts', () => {
  it('counts settlements 1 and cities 2', () => {
    const G = fakeG([])
    G.buildings.vertices = {
      a: { player: 0, type: 'settlement' },
      b: { player: 0, type: 'city' },
      c: { player: 2, type: 'settlement' },
    }
    expect(vpCounts(G)).toEqual([3, 0, 1, 0])
  })
})

// fake events + tiny spy (kept local so the game module stays dependency-free)
type Events = Parameters<typeof _internals.beginRobberFlow>[1]

function fakeEvents(overrides: Partial<Events>): Events {
  return {
    endTurn: () => {},
    setPhase: () => {},
    setActivePlayers: () => {},
    endStage: () => {},
    ...overrides,
  }
}

function fnSpy() {
  const calls: unknown[][] = []
  const fn = (...args: unknown[]) => calls.push(args)
  return { fn, calls }
}

import { describe, expect, it } from 'vitest'
import { Client } from 'boardgame.io/client'
import { INVALID_MOVE } from 'boardgame.io/core'
import {
  BUILD_COSTS,
  CatanGame,
  SUPPLY_LIMITS,
  _internals,
  bankTradeRate,
  createCatanGame,
  pieceCounts,
  validCityVertices,
  validRoadEdges,
  validSetupEdges,
  validSetupVertices,
  validSettlementVertices,
  vpCounts,
  type BgioState,
  type GameState,
} from './catan'
import { generateBoard, type Board } from './board'
import { emptyResourceCounts, RESOURCES, totalCards, type Resource, type ResourceCounts } from './terrain'

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

/**
 * Roll (as whoever's turn it is) until a non-7 shows, resolving any robber
 * flow on the way. Needed because bgio 0.50's local client ignores the `seed`
 * option — rolls are genuinely random, so tests must tolerate surprise 7s.
 */
function rollUntilProducing(client: ReturnType<typeof makeClient>, boardSeed: number) {
  for (let guard = 0; guard < 60; guard++) {
    asPlayer(client, state(client).ctx.currentPlayer)
    client.moves.roll()
    let { G } = state(client)
    if (!G.robberStep) return
    if (G.robberStep === 'discard') {
      while (Object.keys(state(client).G.pendingDiscards).length > 0) {
        for (const [pidStr, required] of Object.entries(state(client).G.pendingDiscards)) {
          const pid = Number(pidStr)
          const hand = state(client).G.hands[pid]
          const cards: Record<string, number> = {}
          let left = required as number
          for (const r of ['wood', 'brick', 'grain', 'wool', 'ore'] as const) {
            const take = Math.min(left, hand[r])
            cards[r] = take
            left -= take
          }
          asPlayer(client, pid)
          client.moves.discardHalf(cards)
        }
      }
    }
    G = state(client).G
    const board = generateBoard(boardSeed)
    asPlayer(client, state(client).ctx.currentPlayer) // robber moves are the mover's
    client.moves.moveRobber(board.tiles.find((t) => t.id !== G.robberTileId)!.id)
    const after = state(client)
    if (after.G.robberStep === 'steal') client.moves.steal(after.G.stealTargets![0])
    client.moves.endTurn()
  }
  throw new Error('never rolled a non-7 (statistically impossible)')
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

    rollUntilProducing(client, 11) // skips (and conserves through) any random 7s
    const after = state(client).G

    expect(after.rolled).toBe(true)
    expect(after.lastRoll!.sum).not.toBe(7)
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

    rollUntilProducing(client, 11) // a surprise 7 is resolved on the way
    const roller = Number(state(client).ctx.currentPlayer)
    asPlayer(client, roller)
    client.moves.endTurn()
    expect(state(client).ctx.currentPlayer).toBe(String((roller + 1) % 4))
    expect(state(client).G.rolled).toBe(false) // reset for the new turn
  })

  it('moves are gated to the active player', () => {
    const client = makeClient(11)
    runSetup(client)

    // player 1 cannot roll (or do anything) during player 0's turn
    asPlayer(client, 1)
    client.moves.roll()
    expect(state(client).G.rolled).toBe(false)

    asPlayer(client, 0)
    client.moves.roll()
    expect(state(client).G.rolled).toBe(true)
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

// -- building rules (M9) ----------------------------------------------------------

const mainMoves = CatanGame.phases.main.moves
const respondMoves = CatanGame.phases.main.turn.stages.respond.moves
const ctx0 = { currentPlayer: '0', turn: 20, phase: 'main', activePlayers: null }

/** Post-setup clone with G.rolled = true and an optional hand override for player 0. */
function mainG(seed: number, hand0?: number[]): GameState {
  const client = makeClient(seed)
  runSetup(client)
  const G = structuredClone(state(client).G)
  G.rolled = true
  if (hand0) {
    const h = emptyResourceCounts()
    const order = ['wood', 'brick', 'grain', 'wool', 'ore'] as const
    hand0.forEach((n, i) => (h[order[i]] = n))
    G.hands[0] = h
  }
  return G
}

const economy = (G: GameState) =>
  Object.values(G.bank).reduce((a, b) => a + b, 0) + G.hands.reduce((a, h) => a + totalCards(h), 0)

describe('building rules (M9)', () => {
  it('road costs 1 lumber + 1 brick and conserves the economy', () => {
    const G = mainG(11, [3, 2, 0, 0, 0])
    const edge = validRoadEdges(G, 0)[0]
    expect(edge).toBeTruthy()

    const before = economy(G)
    expect(mainMoves.placeRoad({ G, ctx: ctx0 }, edge)).toBeUndefined()
    expect(G.buildings.edges[edge]).toEqual({ player: 0 })
    expect(G.hands[0]).toEqual({ wood: 2, brick: 1, grain: 0, wool: 0, ore: 0 })
    expect(G.bank.wood).toBeGreaterThan(0)
    expect(economy(G)).toBe(before)
  })

  it('rejects builds the player cannot afford', () => {
    const G = mainG(11, [1, 1, 0, 0, 0]) // exactly one road's worth, zero margin
    mainMoves.placeRoad({ G, ctx: ctx0 }, validRoadEdges(G, 0)[0])
    expect(validRoadEdges(G, 0)).toEqual([]) // spent it — nothing left to afford

    const G2 = mainG(11, [1, 0, 0, 0, 0])
    const anyEdge = generateBoard(11).edges.find((e) => !G2.buildings.edges[e.id])!.id
    expect(mainMoves.placeRoad({ G: G2, ctx: ctx0 }, anyEdge)).toBe(INVALID_MOVE)
    expect(G2.buildings.edges[anyEdge]).toBeUndefined()
  })

  it('roads must connect to the own network or an own building', () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    const board = generateBoard(11)
    const far = board.edges.find(
      (e) => !G.buildings.edges[e.id] && !validRoadEdges(G, 0).includes(e.id),
    )!
    expect(mainMoves.placeRoad({ G, ctx: ctx0 }, far.id)).toBe(INVALID_MOVE)

    const near = validRoadEdges(G, 0)[0] // touches a setup settlement/road
    expect(mainMoves.placeRoad({ G, ctx: ctx0 }, near)).toBeUndefined()
  })

  it("an opponent's settlement on a junction breaks road continuity", () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    const board: Board = generateBoard(11)
    G.buildings = { vertices: {}, edges: {} } // isolate the scenario

    const v = board.vertices.find((vx) => vx.edgeIds.length === 3)!
    const [e1, e2] = v.edgeIds
    G.buildings.edges[e1] = { player: 0 } // own road reaches junction v
    G.buildings.vertices[v.id] = { player: 1, type: 'settlement' } // …but an opponent sits there

    // edges beyond v can't connect through the occupied junction
    // (edges branching off e1's far end stay legal — that's correct rules)
    expect(validRoadEdges(G, 0)).not.toContain(e2)
    expect(mainMoves.placeRoad({ G, ctx: ctx0 }, e2)).toBe(INVALID_MOVE)

    delete G.buildings.vertices[v.id] // opponent leaves → junction is passable again
    expect(validRoadEdges(G, 0)).toContain(e2)
    expect(mainMoves.placeRoad({ G, ctx: ctx0 }, e2)).toBeUndefined()
  })

  it('settlements need an own road, the distance rule, and the full cost', () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    const board = generateBoard(11)
    G.buildings = { vertices: {}, edges: {} }

    const v = board.vertices.find((vx) => vx.edgeIds.length === 3)!
    G.buildings.edges[v.edgeIds[0]] = { player: 0 }

    // both ends of the own road are legal settlement spots
    const other = board.edgeById.get(v.edgeIds[0])!.vertexIds.find((id) => id !== v.id)!
    expect(validSettlementVertices(G, 0).sort()).toEqual([other, v.id].sort())

    // a neighbor building blocks the junction (distance rule)
    const neighbor = board.edgeById.get(v.edgeIds[0])!.vertexIds.find((id) => id !== v.id)!
    G.buildings.vertices[neighbor] = { player: 1, type: 'settlement' }
    expect(validSettlementVertices(G, 0)).toEqual([])
    delete G.buildings.vertices[neighbor]

    const before = economy(G)
    expect(mainMoves.placeSettlement({ G, ctx: ctx0 }, v.id)).toBeUndefined()
    expect(G.buildings.vertices[v.id]).toEqual({ player: 0, type: 'settlement' })
    expect(G.hands[0]).toEqual({ wood: 8, brick: 8, grain: 8, wool: 8, ore: 9 })
    expect(economy(G)).toBe(before)
  })

  it('settlements are only placed next to an own road, not just any empty junction', () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    const board = generateBoard(11)
    G.buildings = { vertices: {}, edges: {} }
    const v = board.vertices.find((vx) => vx.edgeIds.length === 3)!
    expect(validSettlementVertices(G, 0)).toEqual([]) // no roads anywhere
    expect(mainMoves.placeSettlement({ G, ctx: ctx0 }, v.id)).toBe(INVALID_MOVE)
  })

  it('cities upgrade own settlements for 2 grain + 3 ore (settlement returns to supply)', () => {
    const G = mainG(11, [0, 0, 5, 0, 5])
    const target = validCityVertices(G, 0)[0]
    expect(target).toBeTruthy()

    const vpsBefore = vpCounts(G)[0]
    const before = economy(G)
    expect(mainMoves.upgradeCity({ G, ctx: ctx0 }, target)).toBeUndefined()
    expect(G.buildings.vertices[target]).toEqual({ player: 0, type: 'city' })
    expect(G.hands[0]).toEqual({ wood: 0, brick: 0, grain: 3, wool: 0, ore: 2 })
    expect(vpCounts(G)[0]).toBe(vpsBefore + 1) // settlement 1 → city 2
    expect(economy(G)).toBe(before)

    // other players' settlements and already-built cities are not upgradable
    expect(validCityVertices(G, 0)).toEqual([])
    expect(mainMoves.upgradeCity({ G, ctx: ctx0 }, target)).toBe(INVALID_MOVE)
    const foreign = Object.entries(G.buildings.vertices).find(([, b]) => b.player === 1)![0]
    expect(mainMoves.upgradeCity({ G, ctx: ctx0 }, foreign)).toBe(INVALID_MOVE)
  })

  it('supply limits: 15 roads / 5 settlements / 4 cities per player', () => {
    const board = generateBoard(11)
    const G = mainG(11, [19, 19, 19, 19, 19])

    // exhaust every supply and watch the validators empty out
    for (const e of board.edges.slice(0, SUPPLY_LIMITS.road)) G.buildings.edges[e.id] = { player: 0 }
    expect(validRoadEdges(G, 0)).toEqual([])

    const interior = board.vertices.filter((vx) => vx.edgeIds.length === 3)
    for (const v of interior.slice(0, SUPPLY_LIMITS.settlement))
      G.buildings.vertices[v.id] = { player: 0, type: 'settlement' }
    expect(validSettlementVertices(G, 0)).toEqual([])

    for (const v of interior.slice(SUPPLY_LIMITS.settlement, SUPPLY_LIMITS.settlement + 4))
      G.buildings.vertices[v.id] = { player: 0, type: 'city' }
    expect(validCityVertices(G, 0)).toEqual([])

    // upgrading frees a settlement slot again (piece returns to supply)
    delete G.buildings.vertices[interior[SUPPLY_LIMITS.settlement].id] // make room for one city
    const before = pieceCounts(G, 0)
    const target = interior[0].id
    expect(mainMoves.upgradeCity({ G, ctx: ctx0 }, target)).toBeUndefined()
    expect(pieceCounts(G, 0).settlement).toBe(before.settlement - 1)
    expect(pieceCounts(G, 0).city).toBe(SUPPLY_LIMITS.city)
  })

  it('client rejects builds before the roll and free builds are gone', () => {
    const client = makeClient(11)
    runSetup(client)
    asPlayer(client, 0)
    const own = Object.entries(state(client).G.buildings.vertices).find(([, b]) => b.player === 0)![0]

    client.moves.upgradeCity(own) // before rolling → gated
    expect(state(client).G.buildings.vertices[own]!.type).toBe('settlement')

    client.moves.roll()
    if (state(client).G.robberStep) {
      // resolve a possible 7 so the turn is buildable again
      const board = generateBoard(11)
      const s = state(client)
      client.moves.moveRobber(board.tiles.find((t) => t.id !== s.G.robberTileId)!.id)
      const after = state(client)
      if (after.G.robberStep === 'steal') client.moves.steal(after.G.stealTargets![0])
    }
    client.moves.upgradeCity(own) // affordable? if not, still rejected — but never free
    const type = state(client).G.buildings.vertices[own]!.type
    expect(type === 'settlement' || type === 'city').toBe(true)
  })
})

describe('BUILD_COSTS match PRD §5.7', () => {
  it('road 1 lumber + 1 brick; settlement adds grain + wool; city 2 grain + 3 ore', () => {
    expect(BUILD_COSTS.road).toEqual({ wood: 1, brick: 1 })
    expect(BUILD_COSTS.settlement).toEqual({ wood: 1, brick: 1, grain: 1, wool: 1 })
    expect(BUILD_COSTS.city).toEqual({ grain: 2, ore: 3 })
  })
})

// -- trading (M10) -----------------------------------------------------------------

const oneOf = (r: Resource): Partial<ResourceCounts> => {
  const c: Partial<ResourceCounts> = {}
  c[r] = 1
  return c
}

/** ctx with `pid` sitting in the trade-respond stage. */
const ctxRespond = (pid: number | string) => ({
  currentPlayer: ctx0.currentPlayer,
  turn: ctx0.turn,
  phase: 'main',
  activePlayers: { [String(pid)]: 'respond' } as Record<string, string>,
})

describe('trading (M10)', () => {
  it('bankTradeRate: 4 by default, 3 via a generic port, 2 via the matching special port', () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    const board = generateBoard(11)
    G.buildings = { vertices: {}, edges: {} } // no port buildings yet
    for (const r of RESOURCES) expect(bankTradeRate(G, 0, r)).toBe(4)

    const generic = board.ports.find((p) => p.kind === 'generic')!
    G.buildings.vertices[generic.vertexIds[0]] = { player: 0, type: 'settlement' }
    for (const r of RESOURCES) expect(bankTradeRate(G, 0, r)).toBe(3)

    const woolPort = board.ports.find((p) => p.kind === 'wool')!
    G.buildings.vertices[woolPort.vertexIds[0]] = { player: 0, type: 'settlement' }
    expect(bankTradeRate(G, 0, 'wool')).toBe(2)
    for (const r of RESOURCES.filter((x) => x !== 'wool')) expect(bankTradeRate(G, 0, r)).toBe(3)

    // an opponent's port building gives no rate
    G.buildings.vertices[woolPort.vertexIds[0]] = { player: 1, type: 'city' }
    expect(bankTradeRate(G, 0, 'wool')).toBe(3)
  })

  it('tradeBank: 4:1 with the bank, conserved, and rejected when illegal', () => {
    const G = mainG(11, [4, 0, 0, 0, 1]) // 4 wood + 1 ore
    const before = economy(G)
    const bankBefore = { ...G.bank }
    expect(mainMoves.tradeBank({ G, ctx: ctx0 }, 'wood', 'brick')).toBeUndefined()
    expect(G.hands[0]).toEqual({ wood: 0, brick: 1, grain: 0, wool: 0, ore: 1 })
    expect(G.bank.wood).toBe(bankBefore.wood + 4)
    expect(G.bank.brick).toBe(bankBefore.brick - 1)
    expect(economy(G)).toBe(before)

    // spent — can't afford another
    expect(mainMoves.tradeBank({ G, ctx: ctx0 }, 'wood', 'brick')).toBe(INVALID_MOVE)

    // identical-resource and empty-stack rejections
    const G2 = mainG(11, [4, 0, 0, 0, 0])
    expect(mainMoves.tradeBank({ G: G2, ctx: ctx0 }, 'wood', 'wood')).toBe(INVALID_MOVE)
    G2.bank.brick = 0
    expect(mainMoves.tradeBank({ G: G2, ctx: ctx0 }, 'wood', 'brick')).toBe(INVALID_MOVE)

    // must have rolled first
    const G3 = mainG(11, [9, 9, 9, 9, 9])
    G3.rolled = false
    expect(mainMoves.tradeBank({ G: G3, ctx: ctx0 }, 'wood', 'brick')).toBe(INVALID_MOVE)
  })

  it('tradeBank honors port rates (2 wool → 1 wood via the wool port)', () => {
    const G = mainG(11, [0, 0, 0, 2, 0])
    const woolPort = generateBoard(11).ports.find((p) => p.kind === 'wool')!
    G.buildings.vertices[woolPort.vertexIds[0]] = { player: 0, type: 'settlement' }
    expect(mainMoves.tradeBank({ G, ctx: ctx0 }, 'wool', 'wood')).toBeUndefined()
    expect(G.hands[0]).toEqual({ wood: 1, brick: 0, grain: 0, wool: 0, ore: 0 })
  })

  it('proposeTrade + acceptTrade swap exactly the agreed cards', () => {
    const G = mainG(11, [2, 1, 0, 0, 0])
    G.hands[2] = { wood: 0, brick: 0, grain: 2, wool: 1, ore: 0 }
    const before = economy(G)

    const res = mainMoves.proposeTrade(
      { G, ctx: ctx0, events: fakeEvents({}), playerID: '0' },
      2,
      { wood: 2 },
      { grain: 1 },
    )
    expect(res).toBeUndefined()
    expect(G.pendingTrade).toEqual({
      proposer: 0,
      partner: 2,
      give: { wood: 2, brick: 0, grain: 0, wool: 0, ore: 0 },
      take: { wood: 0, brick: 0, grain: 1, wool: 0, ore: 0 },
    })

    // nobody may accept outside the respond stage, and only the partner
    expect(respondMoves.acceptTrade({ G, ctx: ctx0, playerID: '0' })).toBe(INVALID_MOVE)
    expect(respondMoves.acceptTrade({ G, ctx: ctxRespond(2), playerID: '1' })).toBe(INVALID_MOVE)

    expect(respondMoves.acceptTrade({ G, ctx: ctxRespond(2), playerID: '2' })).toBeUndefined()
    expect(G.pendingTrade).toBeNull()
    expect(G.hands[0]).toEqual({ wood: 0, brick: 1, grain: 1, wool: 0, ore: 0 })
    expect(G.hands[2]).toEqual({ wood: 2, brick: 0, grain: 1, wool: 1, ore: 0 })
    expect(economy(G)).toBe(before)
  })

  it('declineTrade leaves every hand untouched', () => {
    const G = mainG(11, [1, 0, 0, 0, 0])
    G.hands[1] = { wood: 0, brick: 0, grain: 0, wool: 1, ore: 0 }
    mainMoves.proposeTrade({ G, ctx: ctx0, events: fakeEvents({}), playerID: '0' }, 1, oneOf('wood'), oneOf('wool'))
    expect(G.pendingTrade).not.toBeNull()

    expect(respondMoves.declineTrade({ G, ctx: ctxRespond(1), playerID: '1' })).toBeUndefined()
    expect(G.pendingTrade).toBeNull()
    expect(G.hands[0]).toEqual({ wood: 1, brick: 0, grain: 0, wool: 0, ore: 0 })
    expect(G.hands[1]).toEqual({ wood: 0, brick: 0, grain: 0, wool: 1, ore: 0 })
  })

  it('proposeTrade validation: self/bogus partner, identical resources, short hands, empty sides', () => {
    const G = mainG(11, [2, 0, 0, 0, 0])
    G.hands[1] = { wood: 1, brick: 1, grain: 0, wool: 0, ore: 0 }
    const events = fakeEvents({})
    const propose = (partner: number, give: Partial<ResourceCounts>, take: Partial<ResourceCounts>) =>
      mainMoves.proposeTrade({ G, ctx: ctx0, events, playerID: '0' }, partner, give, take)

    expect(propose(0, oneOf('wood'), oneOf('brick'))).toBe(INVALID_MOVE) // self
    expect(propose(9, oneOf('wood'), oneOf('brick'))).toBe(INVALID_MOVE) // bogus partner
    expect(propose(1, oneOf('wood'), oneOf('wood'))).toBe(INVALID_MOVE) // identical resources
    expect(propose(1, { wood: 3 }, oneOf('brick'))).toBe(INVALID_MOVE) // proposer short
    expect(propose(1, oneOf('wood'), oneOf('grain'))).toBe(INVALID_MOVE) // partner short
    expect(propose(1, {}, oneOf('brick'))).toBe(INVALID_MOVE) // empty give
    expect(propose(1, oneOf('wood'), {})).toBe(INVALID_MOVE) // empty take
    expect(G.pendingTrade).toBeNull() // nothing slipped through
  })

  it('client: a pending offer locks the turn until the partner responds', () => {
    const client = makeClient(11)
    runSetup(client)
    // random 7s can shift the turn and even steal a proposer's last card, so
    // keep rolling until the current player has a tradable pair with someone
    let proposer = -1
    let partner = -1
    let give: Resource | null = null
    let take: Resource | null = null
    for (let guard = 0; guard < 40 && partner < 0; guard++) {
      rollUntilProducing(client, 11)
      const s0 = state(client)
      proposer = Number(s0.ctx.currentPlayer)
      outer: for (const p of [0, 1, 2, 3]) {
        if (p === proposer) continue
        for (const r1 of RESOURCES) {
          if (s0.G.hands[proposer][r1] === 0) continue
          for (const r2 of RESOURCES) {
            if (r2 !== r1 && s0.G.hands[p][r2] > 0) {
              partner = p
              give = r1
              take = r2
              break outer
            }
          }
        }
      }
      if (partner < 0) {
        asPlayer(client, s0.ctx.currentPlayer)
        client.moves.endTurn()
      }
    }
    expect(partner).toBeGreaterThanOrEqual(0) // setup always leaves tradable cards
    let s = state(client)

    const handsBefore = structuredClone(s.G.hands)
    asPlayer(client, proposer)
    client.moves.proposeTrade(partner, oneOf(give!), oneOf(take!))
    s = state(client)
    expect(s.G.pendingTrade).not.toBeNull()
    expect(s.ctx.activePlayers?.[String(partner)]).toBe('respond')

    // proposer is locked while the offer stands
    client.moves.endTurn()
    client.moves.tradeBank(give!, take!)
    s = state(client)
    expect(s.ctx.currentPlayer).toBe(String(proposer))
    expect(s.G.pendingTrade).not.toBeNull()

    // a bystander can't answer
    const bystander = [0, 1, 2, 3].find((p) => p !== proposer && p !== partner)!
    asPlayer(client, bystander)
    client.moves.acceptTrade()
    expect(state(client).G.pendingTrade).not.toBeNull()

    // the partner accepts → cards swap, proposer's turn continues
    asPlayer(client, partner)
    client.moves.acceptTrade()
    s = state(client)
    expect(s.G.pendingTrade).toBeNull()
    expect(s.ctx.currentPlayer).toBe(String(proposer))
    expect(s.G.rolled).toBe(true)
    expect(s.G.hands[proposer][give!]).toBe(handsBefore[proposer][give!] - 1)
    expect(s.G.hands[proposer][take!]).toBe(handsBefore[proposer][take!] + 1)
    expect(s.G.hands[partner][give!]).toBe(handsBefore[partner][give!] + 1)
    expect(s.G.hands[partner][take!]).toBe(handsBefore[partner][take!] - 1)
    expect(s.G.hands.reduce((a, h) => a + totalCards(h), 0)).toBe(
      handsBefore.reduce((a, h) => a + totalCards(h), 0),
    )
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

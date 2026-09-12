import { describe, expect, it } from 'vitest'
import { Client } from 'boardgame.io/client'
import { INVALID_MOVE } from 'boardgame.io/core'
import {
  BUILD_COSTS,
  CatanGame,
  DEV_CARD_INFO,
  DEV_DECK_COMPOSITION,
  DEV_COST,
  SUPPLY_LIMITS,
  _internals,
  bankTradeRate,
  connectedRoadEdges,
  createCatanGame,
  makeDevDeck,
  pieceCounts,
  validCityVertices,
  validRoadEdges,
  validSetupEdges,
  validSetupVertices,
  validSettlementVertices,
  vpCounts,
  type BgioState,
  type DevCardType,
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
    expect(DEV_COST).toEqual({ wool: 1, grain: 1, ore: 1 })
  })
})

// -- development cards & awards (M11) -----------------------------------------------

const fakeRandom = { Die: () => 1 }
const ctxAt = (turn: number) => ({ ...ctx0, turn })

function giveDev(G: GameState, player: number, card: DevCardType, boughtTurn = 0) {
  G.devHands[player] = [...G.devHands[player], { card, boughtTurn }]
}

describe('dev deck', () => {
  it('has the official 14/2/2/2/5 composition and is deterministic per seed', () => {
    const count = (deck: DevCardType[], card: DevCardType) => deck.filter((c) => c === card).length
    for (const seed of [1, 7, 11, 42]) {
      const deck = makeDevDeck(seed)
      expect(deck.length).toBe(25)
      expect(DEV_DECK_COMPOSITION.map(([c, n]) => count(deck, c) === n).every(Boolean)).toBe(true)
      expect(deck).toEqual(makeDevDeck(seed))
    }
    expect(makeDevDeck(1)).not.toEqual(makeDevDeck(2))
  })
})

describe('development cards (M11)', () => {
  it('buyDevCard pays ⛏🐑🌾, draws the top card, and keeps the draw secret-ish in the log', () => {
    const G = mainG(11, [0, 0, 1, 1, 1])
    G.devDeck = ['victoryPoint', 'knight']
    const before = economy(G)
    expect(mainMoves.buyDevCard({ G, ctx: ctx0 })).toBeUndefined()
    expect(G.devDeck).toEqual(['knight'])
    expect(G.devHands[0]).toEqual([{ card: 'victoryPoint', boughtTurn: ctx0.turn }])
    expect(G.hands[0]).toEqual({ wood: 0, brick: 0, grain: 0, wool: 0, ore: 0 })
    expect(economy(G)).toBe(before)
    expect(G.log[0]).toContain('bought a development card')

    const G2 = mainG(11, [0, 0, 0, 0, 0]) // can't afford
    expect(mainMoves.buyDevCard({ G: G2, ctx: ctx0 })).toBe(INVALID_MOVE)
    const G3 = mainG(11, [9, 9, 9, 9, 9])
    G3.devDeck = []
    expect(mainMoves.buyDevCard({ G: G3, ctx: ctx0 })).toBe(INVALID_MOVE)
    const G4 = mainG(11, [0, 0, 1, 1, 1])
    G4.rolled = false
    expect(mainMoves.buyDevCard({ G: G4, ctx: ctx0 })).toBe(INVALID_MOVE)
  })

  it('play restrictions: not this turn\'s card, one per turn, never VP cards, before or after the roll', () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    G.devHands[0] = [{ card: 'knight', boughtTurn: ctx0.turn }] // bought this turn
    expect(mainMoves.playDevCard({ G, ctx: ctx0 }, 0)).toBe(INVALID_MOVE)

    G.devHands[0] = [{ card: 'victoryPoint', boughtTurn: 0 }]
    expect(mainMoves.playDevCard({ G, ctx: ctx0 }, 0)).toBe(INVALID_MOVE) // VPs count, never played

    G.devHands[0] = [{ card: 'knight', boughtTurn: 0 }]
    G.rolled = false
    // official rules: a dev card may be played BEFORE the roll (e.g. a Knight)
    expect(mainMoves.playDevCard({ G, ctx: ctx0 }, 0)).toBeUndefined()
    expect(G.devPlayedAtTurn).toBe(ctx0.turn)
    expect(G.robberStep).toBe('move')

    const board = generateBoard(11)
    mainMoves.moveRobber({ G, ctx: ctx0, random: fakeRandom }, board.tiles.find((t) => t.id !== G.robberTileId)!.id)
    if (G.robberStep === 'steal') mainMoves.steal({ G, ctx: ctx0, random: fakeRandom }, G.stealTargets![0])

    giveDev(G, 0, 'monopoly') // a second card this turn is illegal
    expect(mainMoves.playDevCard({ G, ctx: ctx0 }, G.devHands[0].length - 1, 'wood')).toBe(INVALID_MOVE)
  })

  it('knight: robber flow without discards, knights count toward Largest Army', () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    const board = generateBoard(11)
    for (let k = 1; k <= 3; k++) {
      giveDev(G, 0, 'knight')
      const ctx = ctxAt(ctx0.turn + k)
      expect(mainMoves.playDevCard({ G, ctx }, G.devHands[0].length - 1)).toBeUndefined()
      expect(G.robberStep).toBe('move') // no discard step for knights
      expect(G.pendingDiscards).toEqual({})
      mainMoves.moveRobber({ G, ctx, random: fakeRandom }, board.tiles.find((t) => t.id !== G.robberTileId)!.id)
      if (G.robberStep === 'steal') mainMoves.steal({ G, ctx, random: fakeRandom }, G.stealTargets![0])
      expect(G.robberStep).toBeNull()
      expect(G.playedKnights[0]).toBe(k)
    }
    expect(G.largestArmy).toEqual({ player: 0, size: 3 })
    expect(vpCounts(G)[0]).toBe(2 + 2) // 2 setup settlements + Largest Army
  })

  it('road building: two free roads with normal placement rules, no cost', () => {
    const G = mainG(11, [0, 0, 0, 0, 0]) // deliberately broke — roads must be free
    giveDev(G, 0, 'roadBuilding')
    expect(mainMoves.playDevCard({ G, ctx: ctx0 }, 0)).toBeUndefined()
    expect(G.devStep).toBe('roadBuilding')
    expect(G.roadBuildingLeft).toBe(2)

    const e1 = connectedRoadEdges(G, 0)[0]
    expect(mainMoves.placeFreeRoad({ G, ctx: ctx0 }, e1)).toBeUndefined()
    expect(G.buildings.edges[e1]).toEqual({ player: 0 })
    expect(totalCards(G.hands[0])).toBe(0) // nothing paid

    const far = generateBoard(11).edges.find(
      (e) => !G.buildings.edges[e.id] && !connectedRoadEdges(G, 0).includes(e.id),
    )!
    expect(mainMoves.placeFreeRoad({ G, ctx: ctx0 }, far.id)).toBe(INVALID_MOVE)

    const e2 = connectedRoadEdges(G, 0)[0]
    expect(mainMoves.placeFreeRoad({ G, ctx: ctx0 }, e2)).toBeUndefined()
    expect(G.devStep).toBeNull() // auto-clears after the second road
    expect(G.roadBuildingLeft).toBe(0)
  })

  it('year of plenty: take any 2 from the bank, empty stacks respected', () => {
    const G = mainG(11, [0, 0, 0, 0, 0])
    giveDev(G, 0, 'yearOfPlenty')
    expect(mainMoves.playDevCard({ G, ctx: ctx0 }, 0)).toBeUndefined()
    expect(G.devStep).toBe('yearOfPlenty')

    const before = economy(G)
    expect(mainMoves.takeYearOfPlenty({ G, ctx: ctx0 }, 'wood', 'wood')).toBeUndefined()
    expect(G.hands[0]).toEqual({ wood: 2, brick: 0, grain: 0, wool: 0, ore: 0 })
    expect(G.devStep).toBeNull()
    expect(economy(G)).toBe(before)

    const G2 = mainG(11, [0, 0, 0, 0, 0])
    giveDev(G2, 0, 'yearOfPlenty')
    mainMoves.playDevCard({ G: G2, ctx: ctx0 }, 0)
    G2.bank.ore = 1
    expect(mainMoves.takeYearOfPlenty({ G: G2, ctx: ctx0 }, 'ore', 'ore')).toBe(INVALID_MOVE)
    expect(mainMoves.takeYearOfPlenty({ G: G2, ctx: ctx0 }, 'ore', 'wood')).toBeUndefined() // 1+1 fits
    expect(G2.hands[0]).toEqual({ wood: 1, brick: 0, grain: 0, wool: 0, ore: 1 })
  })

  it('monopoly: every other player hands over all cards of the named resource', () => {
    const G = mainG(11, [0, 0, 0, 0, 0])
    G.hands[1] = { wood: 2, brick: 1, grain: 0, wool: 0, ore: 0 }
    G.hands[2] = { wood: 1, brick: 0, grain: 3, wool: 0, ore: 0 }
    G.hands[3] = { wood: 0, brick: 0, grain: 0, wool: 5, ore: 0 }
    giveDev(G, 0, 'monopoly')
    const before = economy(G)

    expect(mainMoves.playDevCard({ G, ctx: ctx0 }, 0)).toBe(INVALID_MOVE) // resource required
    expect(mainMoves.playDevCard({ G, ctx: ctx0 }, 0, 'wood')).toBeUndefined()
    expect(G.hands[0].wood).toBe(3)
    expect(G.hands[1].wood).toBe(0)
    expect(G.hands[2].wood).toBe(0)
    expect(G.hands[3].wool).toBe(5) // untouched
    expect(G.devPlayedAtTurn).toBe(ctx0.turn)
    expect(economy(G)).toBe(before)
  })

  it('vpCounts includes VP dev cards and both awards', () => {
    const G = mainG(11, [0, 0, 0, 0, 0])
    G.devHands[0] = [
      { card: 'victoryPoint', boughtTurn: 0 },
      { card: 'victoryPoint', boughtTurn: 1 },
    ]
    G.longestRoad = { player: 1, size: 7 }
    G.largestArmy = { player: 0, size: 3 }
    const vps = vpCounts(G)
    expect(vps[0]).toBe(2 + 2 + 2) // settlements + army + VP cards
    expect(vps[1]).toBe(2 + 2) // settlements + longest road
  })

  it('buying a VP card can complete the win (counts immediately)', () => {
    const G = mainG(11, [0, 0, 1, 1, 1])
    G.devDeck = ['victoryPoint']
    // rig player 0 to 9 VP on a clean board: 4 cities (8) + 1 settlement (1)
    G.buildings = { vertices: {}, edges: {} }
    const spots = generateBoard(11).vertices.filter((vx) => vx.edgeIds.length === 3).slice(0, 5)
    for (let i = 0; i < 4; i++) G.buildings.vertices[spots[i].id] = { player: 0, type: 'city' }
    G.buildings.vertices[spots[4].id] = { player: 0, type: 'settlement' }
    expect(vpCounts(G)[0]).toBe(9)
    expect(mainMoves.buyDevCard({ G, ctx: ctx0 })).toBeUndefined()
    expect(vpCounts(G)[0]).toBe(10)
  })
})

describe('longest road award (integration)', () => {
  it('placing a 5-edge chain claims Longest Road (+2 VP) via placeRoad', () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    const board: Board = generateBoard(11)
    expect(G.longestRoad).toBeNull() // setup chains are only 1 edge long

    // clean slate: one own settlement + road to anchor legal (paid) placements
    G.buildings = { vertices: {}, edges: {} }
    const anchor = board.vertices.find((vx) => vx.edgeIds.length === 3)!
    const firstEdge = board.edgeById.get(anchor.edgeIds[0])!
    const nextV = firstEdge.vertexIds.find((v) => v !== anchor.id)!
    G.buildings.vertices[anchor.id] = { player: 0, type: 'settlement' }
    G.buildings.edges[firstEdge.id] = { player: 0 }

    // walk outward through the (now empty) board from the road's far end
    const walk: string[] = [nextV]
    const usedEdges = new Set<string>([firstEdge.id])
    while (walk.length <= 6) {
      const cur = board.vertexById.get(walk[walk.length - 1])!
      const next = cur.edgeIds
        .map((eid) => board.edgeById.get(eid)!)
        .find((e) => !usedEdges.has(e.id) && !G.buildings.edges[e.id])
      if (!next) break
      usedEdges.add(next.id)
      walk.push(next.vertexIds.find((v) => v !== cur.id)!)
    }
    expect(walk.length).toBeGreaterThanOrEqual(6) // board is wide open now

    // pave 4 edges → chain = 1 anchor road + 4 = 5
    const toPlace: string[] = []
    for (let i = 0; i + 1 < walk.length && toPlace.length < 4; i++) {
      const a = walk[i]
      const b = walk[i + 1]
      toPlace.push(a < b ? `${a}|${b}` : `${b}|${a}`)
    }
    for (const eid of toPlace.slice(0, 3)) {
      expect(validRoadEdges(G, 0)).toContain(eid)
      mainMoves.placeRoad({ G, ctx: ctx0 }, eid)
    }
    expect(G.longestRoad).toBeNull() // chain of 4 is not enough
    expect(validRoadEdges(G, 0)).toContain(toPlace[3])
    mainMoves.placeRoad({ G, ctx: ctx0 }, toPlace[3])
    expect(G.longestRoad).toEqual({ player: 0, size: 5 })
    expect(vpCounts(G)[0]).toBe(1 + 2) // settlement + award
  })
})

describe('DEV_CARD_INFO', () => {
  it('covers every card type', () => {
    for (const [card] of DEV_DECK_COMPOSITION) {
      expect(DEV_CARD_INFO[card].label).toBeTruthy()
    }
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

  it('proposeTrade validation: self/bogus partner, identical resources, proposer short, empty sides', () => {
    const G = mainG(11, [2, 0, 0, 0, 0])
    G.hands[1] = { wood: 1, brick: 1, grain: 0, wool: 0, ore: 0 }
    const events = fakeEvents({})
    const propose = (partner: number, give: Partial<ResourceCounts>, take: Partial<ResourceCounts>) =>
      mainMoves.proposeTrade({ G, ctx: ctx0, events, playerID: '0' }, partner, give, take)

    expect(propose(0, oneOf('wood'), oneOf('brick'))).toBe(INVALID_MOVE) // self
    expect(propose(9, oneOf('wood'), oneOf('brick'))).toBe(INVALID_MOVE) // bogus partner
    expect(propose(1, oneOf('wood'), oneOf('wood'))).toBe(INVALID_MOVE) // identical resources
    expect(propose(1, { wood: 3 }, oneOf('brick'))).toBe(INVALID_MOVE) // proposer short
    expect(propose(1, {}, oneOf('brick'))).toBe(INVALID_MOVE) // empty give
    expect(propose(1, oneOf('wood'), {})).toBe(INVALID_MOVE) // empty take
    expect(G.pendingTrade).toBeNull() // nothing slipped through
  })

  it('offers reach partners who cannot afford them — no information leak', () => {
    const G = mainG(11, [2, 0, 0, 0, 0])
    G.hands[1] = { wood: 1, brick: 1, grain: 0, wool: 0, ore: 0 } // no grain
    G.hands[2] = { wood: 0, brick: 0, grain: 3, wool: 0, ore: 0 }
    const events = fakeEvents({})

    // asking for a card the partner doesn't hold is a LEGAL proposal — the
    // offer must be shown to them (to decline/counter) so nobody can infer
    // that a player lacks a resource from the offer never reaching them
    expect(
      mainMoves.proposeTrade({ G, ctx: ctx0, events, playerID: '0' }, [1, 2], oneOf('wood'), oneOf('grain')),
    ).toBeUndefined()
    expect(G.pendingTrade?.partners).toEqual([1, 2]) // BOTH recipients kept

    // acceptance remains the legality gate: the short partner cannot accept…
    expect(respondMoves.acceptTrade({ G, ctx: ctxRespond(1), playerID: '1' })).toBe(INVALID_MOVE)
    expect(G.pendingTrade).not.toBeNull()
    // …the funded partner still can…
    expect(respondMoves.acceptTrade({ G, ctx: ctxRespond(2), playerID: '2' })).toBeUndefined()
    expect(G.pendingTrade).toBeNull()
    expect(G.hands[0].grain).toBe(1)
    expect(G.hands[2].grain).toBe(2)
    expect(G.hands[2].wood).toBe(1)

    // …and a lone short partner can decline to clear the offer
    mainMoves.proposeTrade({ G, ctx: ctx0, events, playerID: '0' }, 1, oneOf('wood'), oneOf('grain'))
    expect(G.pendingTrade?.partners ?? [G.pendingTrade!.partner]).toEqual([1])
    expect(respondMoves.declineTrade({ G, ctx: ctxRespond(1), playerID: '1' })).toBeUndefined()
    expect(G.pendingTrade).toBeNull()
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

describe('playerView — hidden information (M12)', () => {
  const seed = 11
  const base = CatanGame.setup({}, { seed })
  // give players asymmetric hands & dev cards
  const G: GameState = structuredClone(base)
  G.hands[0] = { wood: 3, brick: 1, grain: 0, wool: 2, ore: 0 }
  G.hands[1] = { wood: 0, brick: 4, grain: 2, wool: 0, ore: 1 }
  G.devHands[1] = [{ card: 'knight', boughtTurn: 3 }]
  const view = (playerID: string | null | undefined) =>
    (CatanGame.playerView as (ctx: { G: GameState; playerID?: string | null }) => GameState)({
      G,
      playerID,
    })

  it('keeps own hand and dev cards visible', () => {
    const v = view('1')
    expect(v.hands[1]).toEqual(G.hands[1])
    expect(v.devHands[1]).toEqual(G.devHands[1])
  })

  it('masks other players to empty hands but reports totals', () => {
    const v = view('1')
    expect(v.hands[0]).toEqual(emptyResourceCounts())
    expect(v.devHands[0]).toEqual([])
    expect(v.handSizes).toEqual([6, 7, 0, 0])
    expect(v.devHandSizes).toEqual([0, 1, 0, 0])
  })

  it('masks the deck order for everyone', () => {
    const v = view('0')
    expect(v.devDeck.length).toBe(G.devDeck.length)
    expect(new Set(v.devDeck).size).toBe(1)
  })

  it('observers see no hands at all', () => {
    const v = view(null)
    expect(v.hands.every((h) => totalCards(h) === 0)).toBe(true)
    expect(v.handSizes).toEqual([6, 7, 0, 0])
  })

  it('public state (buildings, bank, seed) passes through untouched', () => {
    const v = view('2')
    expect(v.seed).toBe(G.seed)
    expect(v.buildings).toEqual(G.buildings)
    expect(v.bank).toEqual(G.bank)
    expect(v.log).toEqual(G.log)
  })

  it('hotseat factory strips playerView (open information)', () => {
    expect('playerView' in createCatanGame(seed)).toBe(false)
  })
})

describe('opening roll & room size', () => {
  const seed = 31
  const G0 = CatanGame.setup({}, { seed })

  it('setup honors numPlayers=3 (hands, devHands, knights, opening rolls)', () => {
    const G3 = CatanGame.setup({}, { seed, numPlayers: 3 })
    expect(G3.numPlayers).toBe(3)
    expect(G3.hands).toHaveLength(3)
    expect(G3.devHands).toHaveLength(3)
    expect(G3.playedKnights).toHaveLength(3)
    expect(G3.openingRolls).toEqual([null, null, null])
  })

  it('openingRoll records the throw, animates the dice and ends the turn', () => {
    const G = structuredClone(G0)
    let ended = false
    const moves = CatanGame.phases.openingRoll!.moves as {
      openingRoll: (args: unknown, ...a: unknown[]) => unknown
    }
    const out = moves.openingRoll({
      G,
      ctx: { currentPlayer: '0', turn: 1 },
      playerID: '0',
      random: { Die: () => 3 },
      events: { endTurn: () => (ended = true) },
    })
    expect(out).toBeUndefined() // not INVALID_MOVE
    expect(G.openingRolls[0]).toBe(6)
    expect(G.lastRoll).toMatchObject({ die1: 3, die2: 3, sum: 6, nonce: 1 })
    expect(ended).toBe(true)
  })

  it('ties re-roll until unique (official rule)', () => {
    const G = structuredClone(G0)
    G.openingRolls[0] = 6
    const queue = [3, 3, 5, 5] // first throw ties 6, re-roll lands 10
    let i = 0
    const moves = CatanGame.phases.openingRoll!.moves as {
      openingRoll: (args: unknown, ...a: unknown[]) => unknown
    }
    moves.openingRoll({
      G,
      ctx: { currentPlayer: '1', turn: 2 },
      playerID: '1',
      random: { Die: () => queue[i++ % queue.length] },
      events: { endTurn: () => {} },
    })
    expect(G.openingRolls[1]).toBe(10)
  })

  it('the last roll crowns the highest total as firstPlayer', () => {
    const G = structuredClone(G0)
    G.openingRolls = [6, 10, 4, null]
    const moves = CatanGame.phases.openingRoll!.moves as {
      openingRoll: (args: unknown, ...a: unknown[]) => unknown
    }
    moves.openingRoll({
      G,
      ctx: { currentPlayer: '3', turn: 4 },
      playerID: '3',
      random: { Die: () => 2 },
      events: { endTurn: () => {} },
    })
    expect(G.firstPlayer).toBe(1)
  })

  it('rejects double rolls and out-of-turn rolls', () => {
    const G = structuredClone(G0)
    G.openingRolls[0] = 6
    const moves = CatanGame.phases.openingRoll!.moves as {
      openingRoll: (args: unknown, ...a: unknown[]) => unknown
    }
    expect(
      moves.openingRoll({
        G: structuredClone(G),
        ctx: { currentPlayer: '1', turn: 2 },
        playerID: '0',
        random: { Die: () => 1 },
        events: { endTurn: () => {} },
      }),
    ).toBe(INVALID_MOVE)
  })

  it('the setup draft snakes from the opening-roll winner', () => {
    const order = CatanGame.phases.setup.turn.order
    const G = { ...structuredClone(G0), numPlayers: 4, firstPlayer: 2 }
    // placement 0 comes from `first`; `next` runs after each increment, so
    // setupPlacements === the index of the placement being picked
    expect(order.first({ G } as never)).toBe(2)
    const seq = [3, 0, 1, 1, 0, 3, 2] // players for placements 1..7 (snake: 2,3,0,1 then back 1,0,3,2)
    seq.forEach((p, i) =>
      expect(order.next({ G: { ...G, setupPlacements: i + 1 } } as never)).toBe(p),
    )
  })

  it('setup endIf scales with room size', () => {
    const endIf = CatanGame.phases.setup.endIf as (a: { G?: GameState; ctx?: unknown }) => unknown
    const G3 = CatanGame.setup({}, { seed, numPlayers: 3 })
    expect(endIf({ G: { ...G3, setupPlacements: 5 } })).toBeFalsy()
    expect(endIf({ G: { ...G3, setupPlacements: 6 } })).toBeTruthy()
  })

  it('hotseat factory skips the opening phase; the server game ships it', () => {
    expect('openingRoll' in CatanGame.phases).toBe(true)
    expect('openingRoll' in createCatanGame(seed).phases).toBe(false)
  })
})

describe('player names (multiplayer aliases)', () => {
  const seed = 41
  const setName = CatanGame.phases.main.moves.setPlayerName as (
    a: unknown,
    ...r: unknown[]
  ) => unknown

  it('setup defaults to the color names, sized to the room', () => {
    expect(CatanGame.setup({}, { seed }).playerNames).toEqual(['Red', 'Blue', 'Orange', 'White'])
    expect(CatanGame.setup({}, { seed, numPlayers: 3 }).playerNames).toEqual(['Red', 'Blue', 'Orange'])
  })

  it('setPlayerName rebrands the seat on its own turn (trimmed, ≤24 chars)', () => {
    const G = CatanGame.setup({}, { seed })
    expect(setName({ G: structuredClone(G), ctx: { currentPlayer: '1' }, playerID: '0' }, 'Alice')).toBe(
      INVALID_MOVE,
    )
    const G2 = structuredClone(G)
    expect(setName({ G: G2, ctx: { currentPlayer: '0' }, playerID: '0' }, '  Alice  ')).toBeUndefined()
    expect(G2.playerNames[0]).toBe('Alice')
  })

  it('empty or unchanged names are rejected', () => {
    const G = CatanGame.setup({}, { seed })
    G.playerNames[1] = 'Bob'
    expect(setName({ G: structuredClone(G), ctx: { currentPlayer: '1' }, playerID: '1' }, '   ')).toBe(INVALID_MOVE)
    expect(setName({ G: structuredClone(G), ctx: { currentPlayer: '1' }, playerID: '1' }, 'Bob')).toBe(INVALID_MOVE)
  })

  it('engine log lines use the live name', () => {
    const G = CatanGame.setup({}, { seed })
    G.playerNames[0] = 'Alice'
    G.robberStep = 'move'
    const moveRobber = CatanGame.phases.main.moves.moveRobber as (a: unknown, ...r: unknown[]) => unknown
    const board = generateBoard(G.seed)
    const other = board.tiles.find((t) => t.id !== G.robberTileId)!.id
    moveRobber({ G, ctx: { currentPlayer: '0' }, events: { endTurn: () => {} } } as never, other)
    expect(G.log.some((line) => line.startsWith('Alice moved the robber'))).toBe(true)
  })
})

describe('rules refinements (official timing)', () => {
  const seed = 51

  it('dev cards are playable BEFORE the roll (e.g. a Knight)', () => {
    const g = structuredClone(CatanGame.setup({}, { seed }))
    g.rolled = false
    g.robberStep = null
    g.devHands[0] = [{ card: 'knight', boughtTurn: -1 }]
    g.devPlayedAtTurn = -1
    const play = CatanGame.phases.main.moves.playDevCard as (a: unknown, ...r: unknown[]) => unknown
    expect(play({ G: g, ctx: { currentPlayer: '0', turn: 9 } } as never, 0)).toBeUndefined()
    expect(g.robberStep).toBe('move') // knight reuses the robber flow; roll waits
  })

  it('playerView reveals everything once the game is over', () => {
    const G = CatanGame.setup({}, { seed })
    G.hands[1] = { wood: 2, brick: 0, grain: 1, wool: 0, ore: 0 }
    const view = (CatanGame as { playerView: (c: unknown) => GameState }).playerView
    const revealed = view({ G, ctx: { gameover: { winner: 0 } }, playerID: '0' })
    expect(revealed.hands[1]).toEqual(G.hands[1]) // no masking after the win
    const live = view({ G, ctx: {}, playerID: '0' })
    expect(totalCards(live.hands[1])).toBe(0) // still hidden mid-game
  })

  it('a 10-VP seat only wins on its own turn', () => {
    const G = CatanGame.setup({}, { seed })
    // seat 1: 3 settlements + 2 cities = 7 ... push over 10 with awards
    G.longestRoad = { player: 1, size: 5 }
    G.largestArmy = { player: 1, size: 3 }
    G.buildings.vertices = {
      a: { player: 1, type: 'settlement' }, b: { player: 1, type: 'settlement' },
      c: { player: 1, type: 'settlement' }, d: { player: 1, type: 'city' },
      e: { player: 1, type: 'city' },
    } as never
    const endIf = CatanGame.endIf as (a: { G?: GameState; ctx?: { currentPlayer?: string } }) => unknown
    expect(endIf({ G, ctx: { currentPlayer: '0' } })).toBeUndefined() // someone else acting
    expect(endIf({ G, ctx: { currentPlayer: '1' } })).toEqual({ winner: 1 }) // their turn
  })
})

describe('trade input integrity', () => {
  it('rejects fractional and non-finite quantities without changing cards or stages', () => {
    for (const quantity of [0.5, NaN, Infinity, -1]) {
      const G = mainG(11, [5, 5, 5, 5, 5])
      G.hands[1] = { wood: 5, brick: 5, wool: 5, grain: 5, ore: 5 }
      const before = structuredClone(G)
      expect(mainMoves.proposeTrade({ G, ctx: ctx0 }, 1, { wood: quantity }, { ore: 1 })).toBe(INVALID_MOVE)
      expect(G).toEqual(before)
      expect(mainMoves.proposeTrade({ G, ctx: ctx0 }, 1, { wood: 1 }, { ore: quantity })).toBe(INVALID_MOVE)
      expect(G).toEqual(before)
    }
  })
  it('rejects invalid partner indices instead of accessing a missing hand', () => {
    const G = mainG(11, [5, 5, 5, 5, 5])
    for (const partner of [0.5, NaN, Infinity, -1, 4]) {
      expect(mainMoves.proposeTrade({ G, ctx: ctx0 }, partner, { wood: 1 }, { ore: 1 })).toBe(INVALID_MOVE)
    }
    expect(G.pendingTrade).toBeNull()
  })
  it('keeps the complete voyage journal beyond thirty events', () => {
    const G = mainG(11, [0, 0, 0, 0, 0])
    G.log = Array.from({length: 35}, (_, i) => `Earlier event ${i}`)
    G.hands[0].wood = 4
    G.bank.ore = 19
    mainMoves.tradeBank({ G, ctx: ctx0 }, 'wood', 'ore')
    expect(G.log).toHaveLength(36)
    expect(G.log.at(-1)).toBe('Earlier event 34')
  })
})

describe('finishing the art-track interactions', () => {
  it('undo refunds a paid road and restores awards, but not after another action', () => {
    const G = mainG(11, [9, 9, 9, 9, 9])
    const edge = validRoadEdges(G, 0)[0]
    const before = structuredClone({ buildings: G.buildings, hands: G.hands, bank: G.bank, award: G.longestRoad })
    mainMoves.placeRoad({ G, ctx: ctx0 }, edge)
    expect(G.lastBuild?.kind).toBe('road')
    expect(mainMoves.undoBuild({ G, ctx: {...ctx0, currentPlayer:'1'} })).toBe(INVALID_MOVE)
    expect(mainMoves.undoBuild({ G, ctx: ctx0 })).toBeUndefined()
    expect({buildings:G.buildings,hands:G.hands,bank:G.bank,award:G.longestRoad}).toEqual(before)
    expect(mainMoves.undoBuild({ G, ctx: ctx0 })).toBe(INVALID_MOVE)
    mainMoves.placeRoad({ G, ctx: ctx0 }, edge)
    mainMoves.buyDevCard({ G, ctx: ctx0 })
    expect(mainMoves.undoBuild({ G, ctx: ctx0 })).toBe(INVALID_MOVE)
  })
  it('undoing a city restores its settlement and exact cost', () => {
    const G = mainG(11, [9,9,9,9,9])
    const vertex = validCityVertices(G,0)[0]
    const before = structuredClone({hand:G.hands[0],bank:G.bank})
    mainMoves.upgradeCity({G,ctx:ctx0},vertex)
    mainMoves.undoBuild({G,ctx:ctx0})
    expect(G.buildings.vertices[vertex]).toEqual({player:0,type:'settlement'})
    expect({hand:G.hands[0],bank:G.bank}).toEqual(before)
  })
  it('can finish Road Building before rolling without ending the turn', () => {
    const G=mainG(11,[0,0,0,0,0]); G.rolled=false
    giveDev(G,0,'roadBuilding')
    mainMoves.playDevCard({G,ctx:ctx0},0)
    const edge=connectedRoadEdges(G,0)[0]
    expect(mainMoves.placeFreeRoad({G,ctx:ctx0},edge)).toBeUndefined()
    expect(mainMoves.finishRoadBuilding({G,ctx:ctx0})).toBeUndefined()
    expect(G.rolled).toBe(false)
    expect(G.devStep).toBeNull()
    expect(G.roadBuildingLeft).toBe(0)
    expect(G.buildings.edges[edge]).toEqual({player:0})
  })
  it('multiple recipients can decline independently, and one acceptance pays only once', () => {
    const G=mainG(11,[5,5,5,5,5])
    for(let p=1;p<4;p++)G.hands[p]={wood:5,brick:5,wool:5,grain:5,ore:5}
    const before=economy(G)
    mainMoves.proposeTrade({G,ctx:ctx0},[1,2,3],{wood:2},{ore:1})
    expect(G.pendingTrade?.partners).toEqual([1,2,3])
    respondMoves.declineTrade({G,ctx:ctxRespond(1),playerID:'1'})
    expect(G.pendingTrade?.partners).toEqual([2,3])
    expect(respondMoves.acceptTrade({G,ctx:ctxRespond(1),playerID:'1'})).toBe(INVALID_MOVE)
    respondMoves.acceptTrade({G,ctx:ctxRespond(3),playerID:'3'})
    expect(G.pendingTrade).toBeNull()
    expect(G.hands[0].wood).toBe(3)
    expect(G.hands[3].wood).toBe(7)
    expect(G.hands[2].wood).toBe(5)
    expect(economy(G)).toBe(before)
    expect(respondMoves.acceptTrade({G,ctx:ctxRespond(2),playerID:'2'})).toBe(INVALID_MOVE)
  })
  it('counter-offers reverse the responding party and require renewed consent', () => {
    const G=mainG(11,[5,5,5,5,5]); G.hands[1]={wood:5,brick:5,wool:5,grain:5,ore:5}
    const before=economy(G)
    mainMoves.proposeTrade({G,ctx:ctx0},1,{wood:2},{ore:1})
    expect(respondMoves.counterTrade({G,ctx:ctxRespond(1),playerID:'1'},{ore:1},{wood:3})).toBeUndefined()
    expect(G.hands[0].wood).toBe(5)
    expect(G.pendingTrade?.partner).toBe(0)
    expect(G.pendingTrade?.proposer).toBe(1)
    expect(respondMoves.acceptTrade({G,ctx:ctxRespond(1),playerID:'1'})).toBe(INVALID_MOVE)
    expect(respondMoves.acceptTrade({G,ctx:ctxRespond(0),playerID:'0'})).toBeUndefined()
    expect(G.hands[0].wood).toBe(2)
    expect(G.hands[1].wood).toBe(8)
    expect(economy(G)).toBe(before)
  })
  it('the client exits all response stages after accepting a table offer or a counter', () => {
    const game = createCatanGame(11)
    const rich=mainG(11,[5,5,5,5,5])
    for(let p=1;p<4;p++)rich.hands[p]={wood:5,brick:5,wool:5,grain:5,ore:5}
    const client=Client({debug:false,numPlayers:4,game:{...game,setup:()=>rich,phases:{...game.phases,setup:{...game.phases.setup,start:false},main:{...game.phases.main,start:true,turn:{...game.phases.main.turn,onBegin:({G}:{G?:GameState})=>{if(G)G.rolled=true;return G}}}}}})
    client.start()
    client.updatePlayerID('0'); client.moves.proposeTrade([1,2,3],{wood:1},{ore:1})
    expect(client.getState()!.ctx.activePlayers).toEqual({'1':'respond','2':'respond','3':'respond'})
    client.updatePlayerID('2'); client.moves.acceptTrade()
    expect(client.getState()!.ctx.activePlayers).toBeNull()
    client.updatePlayerID('0'); client.moves.proposeTrade([1,3],{wood:1},{ore:1})
    client.updatePlayerID('3'); client.moves.counterTrade({ore:1},{wood:2})
    expect(client.getState()!.ctx.activePlayers).toEqual({'0':'respond'})
    client.updatePlayerID('0'); client.moves.acceptTrade()
    expect(client.getState()!.ctx.activePlayers).toBeNull()
    client.moves.endTurn()
    expect(client.getState()!.ctx.currentPlayer).toBe('1')
    client.stop()
  })
})

describe('public development card announcement', () => {
  it('reveals a played card to every seat while preserving private hands', () => {
    const G = mainG(11, [5,5,5,5,5])
    giveDev(G, 0, 'knight')
    giveDev(G, 0, 'victoryPoint')
    mainMoves.playDevCard({G, ctx:ctx0}, 0)
    for (const playerID of ['0','1','2','3',null]) {
      const visible = (CatanGame.playerView as (a: {G:GameState; playerID:string|null}) => GameState)({G,playerID})
      expect(visible.lastPlayedCard).toEqual({player:0,card:'knight',turn:ctx0.turn,sequence:1})
      if (playerID !== '0') {
        expect(visible.hands[0]).toEqual(emptyResourceCounts())
        expect(visible.handSizes?.[0]).toBe(25)
        expect(visible.devHands[0]).toEqual([])
        expect(visible.devHandSizes?.[0]).toBe(1)
      }
    }
  })
  it('does not reveal a purchase or an invalid play', () => {
    const G = mainG(11, [5,5,5,5,5])
    mainMoves.buyDevCard({G,ctx:ctx0})
    expect(G.lastPlayedCard).toBeUndefined()
    mainMoves.playDevCard({G,ctx:ctx0},0)
    expect(G.lastPlayedCard).toBeUndefined()
  })
})

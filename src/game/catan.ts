/**
 * The Catan game for boardgame.io — the authoritative turn engine (M8).
 *
 * Phases:
 *   setup — snake draft (P1→P4, P4→P1): each turn places 1 settlement + 1 road.
 *           Second-round settlements grant their starting resources.
 *   main  — one turn = roll → (produce | robber flow) → trade/build → end turn.
 *           Sub-steps live in G.robberStep: 'discard' → 'move' → 'steal'.
 *
 * Determinism: the board is regenerated from G.seed by every client (and the
 * M12 server) — board topology is never stored in G. All randomness flows
 * through ctx.random so the server can own it in multiplayer.
 *
 * G is immer-managed and must stay JSON-serializable: plain objects only
 * (buildings are Records keyed by vertex/edge id, never Maps).
 */

import { generateBoard, type Board, type EdgeId, type VertexId } from './board'
import { BANK_START, computeProduction, type Building } from './production'
import { INVALID_MOVE } from 'boardgame.io/core'
import {
  RESOURCES,
  TERRAIN_INFO,
  emptyResourceCounts,
  totalCards,
  type Resource,
  type ResourceCounts,
} from './terrain'

export const VICTORY_POINTS = 10

export interface RoadSpot {
  player: number
}

export interface LastRoll {
  die1: number
  die2: number
  sum: number
  /** ctx.turn at throw time — bumps so identical consecutive rolls re-trigger UI. */
  nonce: number
}

export interface LastProduction {
  gains: ResourceCounts[]
  tileIds: string[]
  nonce: number
}

export interface GameState {
  seed: number
  robberTileId: string
  hands: ResourceCounts[]
  bank: ResourceCounts
  buildings: { vertices: Record<VertexId, Building>; edges: Record<EdgeId, RoadSpot> }
  /** Completed setup placements (0–8). */
  setupPlacements: number
  /** True once the current player rolled this turn. */
  rolled: boolean
  lastRoll: LastRoll | null
  lastProduction: LastProduction | null
  /** Robber sub-step within the current turn (null = normal flow). */
  robberStep: 'discard' | 'move' | 'steal' | null
  /** playerId → cards still to discard while robberStep === 'discard'. */
  pendingDiscards: Record<number, number>
  /** Eligible steal victims while robberStep === 'steal'. */
  stealTargets: number[] | null
  log: string[]
}

// -- minimal boardgame.io typings (subset we actually use) -------------------

interface CtxShape {
  currentPlayer: string
  turn: number
  phase: string
  activePlayers: Record<string, string | { stage: string }> | null
}

interface EventsShape {
  endTurn(): void
  setPhase(phase: string): void
  setActivePlayers(cfg: { value: Record<string, { stage: string }> }): void
  endStage(): void
}

interface MoveArgs {
  G?: GameState
  ctx: CtxShape
  playerID?: string | null
  random?: { Die(sides?: number): number }
  events?: EventsShape
}

export interface BgioState {
  G: GameState
  ctx: {
    currentPlayer: string
    turn: number
    phase: string
    activePlayers: Record<string, string | { stage: string }> | null
    gameover: { winner: number } | null
  }
}

const INVALID = INVALID_MOVE // 'INVALID_MOVE' string in boardgame.io 0.50

// -- helpers ------------------------------------------------------------------

const boardCache = new Map<number, Board>()

/** Regenerate (and cache) the island from its seed — identical everywhere. */
export function boardFor(seed: number): Board {
  let board = boardCache.get(seed)
  if (!board) {
    board = generateBoard(seed)
    boardCache.set(seed, board)
  }
  return board
}

const PLAYER_NAMES = ['Red', 'Blue', 'Orange', 'White']

export function vpCounts(G: GameState): number[] {
  const vps = Array.from({ length: G.hands.length }, () => 0)
  for (const b of Object.values(G.buildings.vertices)) vps[b.player] += b.type === 'city' ? 2 : 1
  return vps
}

/** Empty + distance rule (no building on an adjacent junction). */
export function validSetupVertices(G: GameState): VertexId[] {
  const board = boardFor(G.seed)
  const out: VertexId[] = []
  for (const v of board.vertices) {
    if (G.buildings.vertices[v.id]) continue
    const blocked = v.edgeIds.some((eid) => {
      const edge = board.edgeById.get(eid)!
      return edge.vertexIds.some((other) => other !== v.id && G.buildings.vertices[other])
    })
    if (!blocked) out.push(v.id)
  }
  return out
}

/** Empty road spots touching the just-placed setup settlement. */
export function validSetupEdges(G: GameState, vertexId: VertexId): EdgeId[] {
  const board = boardFor(G.seed)
  const v = board.vertexById.get(vertexId)
  if (!v) return []
  return v.edgeIds.filter((eid) => !G.buildings.edges[eid])
}

/** Players (≠ mover) with a building next to the robber's tile and ≥1 card. */
export function robberVictims(G: GameState, tileId: string, mover: number): number[] {
  const board = boardFor(G.seed)
  const tile = board.tileById.get(tileId)
  if (!tile) return []
  const owners = new Set<number>()
  for (const vid of tile.vertexIds) {
    const b = G.buildings.vertices[vid]
    if (b && b.player !== mover) owners.add(b.player)
  }
  return [...owners].filter((p) => totalCards(G.hands[p]) > 0)
}

function pushLog(G: GameState, text: string) {
  G.log.unshift(text)
  if (G.log.length > 30) G.log.length = 30
}

/** Apply production for a roll, updating hands + bank (PRD §5.3.1). */
function applyProduction(G: GameState, sum: number, turn: number) {
  const board = boardFor(G.seed)
  const vertices = new Map(Object.entries(G.buildings.vertices))
  const result = computeProduction(board, vertices, G.robberTileId, sum, G.bank, G.hands.length)
  G.hands = G.hands.map((hand, i) => {
    const gains = result.gains[i]
    const out = { ...hand }
    for (const r of RESOURCES) out[r] += gains[r]
    return out
  })
  G.bank = result.bank
  G.lastProduction = { gains: result.gains, tileIds: result.producingTileIds, nonce: turn }
  if (result.producingTileIds.length === 0) pushLog(G, `rolled ${sum} — nothing produced`)
  else pushLog(G, `rolled ${sum} — ${result.producingTileIds.length} hex(es) produced`)
  if (result.shortages.length > 0) {
    pushLog(G, `⚠ bank exhausted: ${result.shortages.join(', ')}`)
  }
}

/** Begin the 7-flow: discard-half first (if anyone must), else robber move. */
function beginRobberFlow(G: GameState, events: EventsShape) {
  pushLog(G, `rolled 7 — the robber strikes!`)
  const discarders = G.hands
    .map((h, p) => ({ p, total: totalCards(h) }))
    .filter((x) => x.total > 7)
    .map((x) => ({ p: x.p, required: Math.floor(x.total / 2) }))

  if (discarders.length === 0) {
    G.robberStep = 'move'
    return
  }
  G.robberStep = 'discard'
  G.pendingDiscards = Object.fromEntries(discarders.map((d) => [d.p, d.required]))
  for (const d of discarders) pushLog(G, `${PLAYER_NAMES[d.p]} must discard ${d.required}`)
  events.setActivePlayers({
    value: Object.fromEntries(discarders.map((d) => [String(d.p), { stage: 'discard' }])),
  })
}

/** Transfer one random card from victim to thief. `die` returns 1..n. */
function doSteal(G: GameState, victim: number, thief: number, die: (n: number) => number) {
  const pool: Resource[] = []
  for (const r of RESOURCES) for (let i = 0; i < G.hands[victim][r]; i++) pool.push(r)
  if (pool.length === 0) return null
  const card = pool[die(pool.length) - 1]
  G.hands[victim] = { ...G.hands[victim], [card]: G.hands[victim][card] - 1 }
  G.hands[thief] = { ...G.hands[thief], [card]: G.hands[thief][card] + 1 }
  pushLog(G, `${PLAYER_NAMES[thief]} stole a card from ${PLAYER_NAMES[victim]}`)
  return card
}

/** Second-round setup settlements collect 1 card per adjacent producing hex. */
function grantSetupResources(G: GameState, player: number, vertexId: VertexId) {
  const board = boardFor(G.seed)
  const v = board.vertexById.get(vertexId)
  if (!v) return
  for (const tileId of v.tileIds) {
    const tile = board.tileById.get(tileId)!
    const resource = TERRAIN_INFO[tile.terrain].resource
    if (!resource || tile.numberToken === null) continue
    if (G.bank[resource] <= 0) continue // empty-stack rule
    G.bank = { ...G.bank, [resource]: G.bank[resource] - 1 }
    G.hands[player] = { ...G.hands[player], [resource]: G.hands[player][resource] + 1 }
  }
}

// -- moves ---------------------------------------------------------------------

function placeSetup({ G, ctx, events }: MoveArgs, vertexId: VertexId, edgeId: EdgeId) {
  if (!G) return INVALID
  const player = Number(ctx.currentPlayer)
  const board = boardFor(G.seed)
  const vertex = board.vertexById.get(vertexId)
  const edge = board.edgeById.get(edgeId)
  if (!vertex || !edge) return INVALID
  if (G.buildings.vertices[vertexId] || G.buildings.edges[edgeId]) return INVALID
  if (!edge.vertexIds.includes(vertexId)) return INVALID // road must touch the settlement
  if (!validSetupVertices(G).includes(vertexId)) return INVALID // empty + distance rule

  G.buildings.vertices[vertexId] = { player, type: 'settlement' }
  G.buildings.edges[edgeId] = { player }
  const secondRound = G.setupPlacements >= 4
  G.setupPlacements++
  pushLog(G, `${PLAYER_NAMES[player]} placed a settlement${secondRound ? ' (2nd)' : ''} + road`)
  if (secondRound) grantSetupResources(G, player, vertexId)

  // endIf on the setup phase is evaluated at turn end — always end the turn
  events?.endTurn()
}

function roll({ G, ctx, random, events }: MoveArgs) {
  if (!G) return INVALID
  if (G.rolled || G.robberStep) return INVALID
  const die1 = random!.Die(6)
  const die2 = random!.Die(6)
  const sum = die1 + die2
  G.lastRoll = { die1, die2, sum, nonce: ctx.turn }
  G.rolled = true
  if (sum === 7) beginRobberFlow(G, events!)
  else applyProduction(G, sum, ctx.turn)
}

function discardHalf({ G, ctx, playerID, events }: MoveArgs, cards: Partial<ResourceCounts>) {
  if (!G) return INVALID
  if (ctx.activePlayers?.[playerID as string] !== 'discard') return INVALID
  const player = Number(playerID)
  const required = G.pendingDiscards[player]
  if (!required) return INVALID
  let total = 0
  for (const r of RESOURCES) {
    const n = cards[r] ?? 0
    if (n < 0 || n > G.hands[player][r]) return INVALID
    total += n
  }
  if (total !== required) return INVALID

  const hand = { ...G.hands[player] }
  const bank = { ...G.bank }
  for (const r of RESOURCES) {
    if (cards[r]) {
      hand[r] -= cards[r] as number
      bank[r] += cards[r] as number
    }
  }
  G.hands[player] = hand
  G.bank = bank
  delete G.pendingDiscards[player]
  pushLog(G, `${PLAYER_NAMES[player]} discarded ${required}`)
  if (Object.keys(G.pendingDiscards).length === 0) {
    G.robberStep = 'move'
    G.pendingDiscards = {}
  }
  events?.endStage()
}

function moveRobber({ G, ctx, random }: MoveArgs, tileId: string) {
  if (!G) return INVALID
  if (G.robberStep !== 'move') return INVALID
  if (tileId === G.robberTileId) return INVALID
  const board = boardFor(G.seed)
  if (!board.tileById.has(tileId)) return INVALID

  G.robberTileId = tileId
  pushLog(G, `${PLAYER_NAMES[Number(ctx.currentPlayer)]} moved the robber`)
  const mover = Number(ctx.currentPlayer)
  const victims = robberVictims(G, tileId, mover)
  if (victims.length === 0) {
    G.robberStep = null
  } else if (victims.length === 1) {
    doSteal(G, victims[0], mover, (n) => random!.Die(n))
    G.robberStep = null
  } else {
    G.robberStep = 'steal'
    G.stealTargets = victims
  }
}

function steal({ G, ctx, random }: MoveArgs, victimId: number) {
  if (!G) return INVALID
  if (G.robberStep !== 'steal' || !G.stealTargets?.includes(victimId)) return INVALID
  doSteal(G, victimId, Number(ctx.currentPlayer), (n) => random!.Die(n))
  G.robberStep = null
  G.stealTargets = null
}

function placeSettlement({ G, ctx }: MoveArgs, vertexId: VertexId) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep) return INVALID
  if (G.buildings.vertices[vertexId]) return INVALID
  const player = Number(ctx.currentPlayer)
  G.buildings.vertices[vertexId] = { player, type: 'settlement' }
  pushLog(G, `${PLAYER_NAMES[player]} built a settlement`)
}

function placeRoad({ G, ctx }: MoveArgs, edgeId: EdgeId) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep) return INVALID
  if (G.buildings.edges[edgeId]) return INVALID
  const player = Number(ctx.currentPlayer)
  G.buildings.edges[edgeId] = { player }
  pushLog(G, `${PLAYER_NAMES[player]} built a road`)
}

function endTurn({ G, events }: MoveArgs) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep) return INVALID
  events?.endTurn()
}

// -- game definition -----------------------------------------------------------

/** Snake draft order: turns 1–4 → players 0–3, turns 5–8 → players 3–0. */
const setupOrder = {
  first: () => 0,
  next: ({ ctx }: { ctx: { turn: number } }) => {
    const nextTurn = ctx.turn + 1
    if (nextTurn <= 4) return nextTurn - 1
    if (nextTurn <= 8) return 8 - nextTurn
    return 0
  },
}

/** Main phase: the last setup placer (player 0) takes the first turn, then clockwise. */
const mainOrder = {
  first: ({ ctx }: { ctx: { playOrderPos: number } }) => ctx.playOrderPos,
  next: ({ ctx }: { ctx: { playOrderPos: number; playOrder: string[] } }) =>
    (ctx.playOrderPos + 1) % ctx.playOrder.length,
}

export const CatanGame = {
  name: 'catan-3d',
  setup(_ctx: unknown, setupData: { seed?: number } | undefined): GameState {
    const seed = setupData?.seed ?? 1
    const board = boardFor(seed)
    return {
      seed,
      robberTileId: board.desertTileId,
      hands: [0, 1, 2, 3].map(() => emptyResourceCounts()),
      bank: { ...BANK_START },
      buildings: { vertices: {}, edges: {} },
      setupPlacements: 0,
      rolled: false,
      lastRoll: null,
      lastProduction: null,
      robberStep: null,
      pendingDiscards: {},
      stealTargets: null,
      log: [],
    }
  },

  phases: {
    setup: {
      start: true,
      turn: { order: setupOrder },
      moves: { placeSetup },
      endIf: ({ G }: { G?: GameState }) => (G?.setupPlacements ?? 0) >= 8,
      next: 'main',
    },
    main: {
      turn: {
        order: mainOrder,
        onBegin: ({ G }: { G?: GameState }) => {
          if (!G) return G
          G.rolled = false
          G.robberStep = null
          G.stealTargets = null
          G.pendingDiscards = {}
          return G
        },
        stages: {
          discard: { moves: { discardHalf } },
        },
      },
      moves: { roll, moveRobber, steal, placeSettlement, placeRoad, endTurn },
    },
  },

  endIf: ({ G }: { G?: GameState }) => {
    if (!G?.hands) return undefined
    const vps = vpCounts(G)
    const winner = vps.findIndex((v) => v >= VICTORY_POINTS)
    return winner >= 0 ? { winner } : undefined
  },
}

/**
 * Local-client game factory: boardgame.io 0.50's local client doesn't forward
 * `setupData` (only the multiplayer server does), so we close over the seed.
 * The setup() above still honors setupData for the M12 server path.
 */
export function createCatanGame(seed: number) {
  return {
    ...CatanGame,
    setup(ctx: unknown) {
      return CatanGame.setup(ctx, { seed })
    },
  }
}

// exported for unit tests (exercised through the client in integration tests)
export const _internals = { applyProduction, beginRobberFlow, doSteal, grantSetupResources }

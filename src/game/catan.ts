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
  RESOURCE_ICONS,
  TERRAIN_INFO,
  emptyResourceCounts,
  totalCards,
  type Resource,
  type ResourceCounts,
} from './terrain'

export const VICTORY_POINTS = 10

/** Build costs paid to the bank (PRD §5.7). Dev cards land in M11. */
export const BUILD_COSTS: Record<'road' | 'settlement' | 'city', Partial<ResourceCounts>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, grain: 1, wool: 1 },
  city: { grain: 2, ore: 3 },
}

/** Hard piece limits per player (PRD §5.1). */
export const SUPPLY_LIMITS = { road: 15, settlement: 5, city: 4 } as const

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
  /** A domestic trade awaiting the partner's response (null = none). */
  pendingTrade: PendingTrade | null
  log: string[]
}

/** A proposed domestic trade: proposer gives `give`, receives `take`. */
export interface PendingTrade {
  proposer: number
  partner: number
  give: ResourceCounts
  take: ResourceCounts
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

/** Pieces a player still has in supply (setup placements count as used). */
export function pieceCounts(
  G: GameState,
  player: number,
): { road: number; settlement: number; city: number } {
  let road = 0
  let settlement = 0
  let city = 0
  for (const e of Object.values(G.buildings.edges)) if (e.player === player) road++
  for (const b of Object.values(G.buildings.vertices)) {
    if (b.player !== player) continue
    if (b.type === 'city') city++
    else settlement++
  }
  return { road, settlement, city }
}

function canAfford(hand: ResourceCounts, cost: Partial<ResourceCounts>): boolean {
  return RESOURCES.every((r) => hand[r] >= (cost[r] ?? 0))
}

/** Pay a build cost to the bank (caller must have checked affordability). */
function payCost(G: GameState, player: number, cost: Partial<ResourceCounts>) {
  const hand = { ...G.hands[player] }
  const bank = { ...G.bank }
  for (const r of RESOURCES) {
    if (!cost[r]) continue
    hand[r] -= cost[r] as number
    bank[r] += cost[r] as number
  }
  G.hands[player] = hand
  G.bank = bank
}

function costLabel(cost: Partial<ResourceCounts>): string {
  return RESOURCES.filter((r) => cost[r]).map((r) => `${RESOURCE_ICONS[r]}×${cost[r]}`).join('')
}

/** Human label for an arbitrary card pile, e.g. `2🪵+1🧱` (empty → `nothing`). */
export function countsLabel(counts: Partial<ResourceCounts>): string {
  const parts = RESOURCES.filter((r) => counts[r]).map((r) => `${counts[r]}${RESOURCE_ICONS[r]}`)
  return parts.length > 0 ? parts.join('+') : 'nothing'
}

/**
 * Best maritime rate for GIVING `resource`: 2 via the matching special port,
 * 3 via any generic port, else 4 — ports need an own building on a corner.
 */
export function bankTradeRate(G: GameState, player: number, resource: Resource): 2 | 3 | 4 {
  const board = boardFor(G.seed)
  const owns = (vids: readonly string[]) =>
    vids.some((vid) => G.buildings.vertices[vid]?.player === player)
  for (const p of board.ports) {
    if (p.kind !== 'generic' && p.kind === resource && owns(p.vertexIds)) return 2
  }
  for (const p of board.ports) {
    if (p.kind === 'generic' && owns(p.vertexIds)) return 3
  }
  return 4
}

/** Distance rule: no existing building on an adjacent junction. */
function respectsDistance(G: GameState, board: Board, vertexId: VertexId): boolean {
  const v = board.vertexById.get(vertexId)
  if (!v) return false
  return !v.edgeIds.some((eid) => {
    const edge = board.edgeById.get(eid)!
    return edge.vertexIds.some((other) => other !== vertexId && G.buildings.vertices[other])
  })
}

/** Empty + distance rule (no building on an adjacent junction). */
export function validSetupVertices(G: GameState): VertexId[] {
  const board = boardFor(G.seed)
  const out: VertexId[] = []
  for (const v of board.vertices) {
    if (G.buildings.vertices[v.id]) continue
    if (respectsDistance(G, board, v.id)) out.push(v.id)
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

/**
 * Can a road connect through this junction? Own building anchors it; an empty
 * junction connects if another own road already touches it; an opponent's
 * building severs the network (PRD §5.3.3 — matters for Longest Road in M11).
 */
function connectsThrough(G: GameState, board: Board, vertexId: VertexId, player: number): boolean {
  const building = G.buildings.vertices[vertexId]
  if (building) return building.player === player
  const v = board.vertexById.get(vertexId)
  if (!v) return false
  return v.edgeIds.some((eid) => G.buildings.edges[eid]?.player === player)
}

/** Fully legal road spots: empty, connected, affordable, supply remaining. */
export function validRoadEdges(G: GameState, player: number): EdgeId[] {
  const board = boardFor(G.seed)
  if (pieceCounts(G, player).road >= SUPPLY_LIMITS.road) return []
  if (!canAfford(G.hands[player], BUILD_COSTS.road)) return []
  const out: EdgeId[] = []
  for (const e of board.edges) {
    if (G.buildings.edges[e.id]) continue
    if (e.vertexIds.some((vid) => connectsThrough(G, board, vid, player))) out.push(e.id)
  }
  return out
}

/** Fully legal settlement spots: empty, distance rule, own road, affordable, supply. */
export function validSettlementVertices(G: GameState, player: number): VertexId[] {
  const board = boardFor(G.seed)
  if (pieceCounts(G, player).settlement >= SUPPLY_LIMITS.settlement) return []
  if (!canAfford(G.hands[player], BUILD_COSTS.settlement)) return []
  const out: VertexId[] = []
  for (const v of board.vertices) {
    if (G.buildings.vertices[v.id]) continue
    if (!respectsDistance(G, board, v.id)) continue
    if (v.edgeIds.some((eid) => G.buildings.edges[eid]?.player === player)) out.push(v.id)
  }
  return out
}

/** Fully legal city upgrades: own settlements, affordable, city supply remaining. */
export function validCityVertices(G: GameState, player: number): VertexId[] {
  if (pieceCounts(G, player).city >= SUPPLY_LIMITS.city) return []
  if (!canAfford(G.hands[player], BUILD_COSTS.city)) return []
  return Object.entries(G.buildings.vertices)
    .filter(([, b]) => b.player === player && b.type === 'settlement')
    .map(([vid]) => vid as VertexId)
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
  const player = Number(ctx.currentPlayer)
  if (!validSettlementVertices(G, player).includes(vertexId)) return INVALID
  payCost(G, player, BUILD_COSTS.settlement)
  G.buildings.vertices[vertexId] = { player, type: 'settlement' }
  pushLog(G, `${PLAYER_NAMES[player]} built a settlement (${costLabel(BUILD_COSTS.settlement)})`)
}

function placeRoad({ G, ctx }: MoveArgs, edgeId: EdgeId) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep) return INVALID
  const player = Number(ctx.currentPlayer)
  if (!validRoadEdges(G, player).includes(edgeId)) return INVALID
  payCost(G, player, BUILD_COSTS.road)
  G.buildings.edges[edgeId] = { player }
  pushLog(G, `${PLAYER_NAMES[player]} built a road (${costLabel(BUILD_COSTS.road)})`)
}

function upgradeCity({ G, ctx }: MoveArgs, vertexId: VertexId) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep) return INVALID
  const player = Number(ctx.currentPlayer)
  if (!validCityVertices(G, player).includes(vertexId)) return INVALID
  payCost(G, player, BUILD_COSTS.city)
  G.buildings.vertices[vertexId] = { player, type: 'city' }
  pushLog(G, `${PLAYER_NAMES[player]} upgraded a city (${costLabel(BUILD_COSTS.city)})`)
}

/** Maritime trade: give `rate` of one resource for 1 of another (PRD §5.3.2). */
function tradeBank({ G, ctx }: MoveArgs, give: Resource, take: Resource) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep || G.pendingTrade) return INVALID
  if (give === take) return INVALID
  const player = Number(ctx.currentPlayer)
  const rate = bankTradeRate(G, player, give)
  if (G.hands[player][give] < rate) return INVALID
  if (G.bank[take] <= 0) return INVALID

  const hand = { ...G.hands[player] }
  const bank = { ...G.bank }
  hand[give] -= rate
  hand[take] += 1
  bank[give] += rate
  bank[take] -= 1
  G.hands[player] = hand
  G.bank = bank
  const via = rate === 4 ? ' with the bank' : rate === 3 ? ' via a 3:1 port' : ' via a 2:1 port'
  pushLog(G, `${PLAYER_NAMES[player]} traded ${rate}${RESOURCE_ICONS[give]} for 1${RESOURCE_ICONS[take]}${via}`)
}

function proposeTrade(
  { G, ctx, events }: MoveArgs,
  partnerId: number,
  give: Partial<ResourceCounts>,
  take: Partial<ResourceCounts>,
) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep || G.pendingTrade) return INVALID
  const proposer = Number(ctx.currentPlayer)
  if (partnerId === proposer || partnerId < 0 || partnerId >= G.hands.length) return INVALID

  const normGive = emptyResourceCounts()
  const normTake = emptyResourceCounts()
  let giveTotal = 0
  let takeTotal = 0
  for (const r of RESOURCES) {
    const g = give[r] ?? 0
    const t = take[r] ?? 0
    if (g < 0 || t < 0) return INVALID
    if (g > 0 && t > 0) return INVALID // may not trade identical resources
    if (g > G.hands[proposer][r] || t > G.hands[partnerId][r]) return INVALID
    normGive[r] = g
    normTake[r] = t
    giveTotal += g
    takeTotal += t
  }
  if (giveTotal < 1 || takeTotal < 1) return INVALID

  G.pendingTrade = { proposer, partner: partnerId, give: normGive, take: normTake }
  pushLog(
    G,
    `${PLAYER_NAMES[proposer]} offers ${PLAYER_NAMES[partnerId]}: ${countsLabel(normGive)} for ${countsLabel(normTake)}`,
  )
  events?.setActivePlayers({ value: { [String(partnerId)]: { stage: 'respond' } } })
}

function acceptTrade({ G, ctx, playerID, events }: MoveArgs) {
  if (!G) return INVALID
  const t = G.pendingTrade
  if (!t) return INVALID
  if (ctx.activePlayers?.[playerID as string] !== 'respond') return INVALID
  if (Number(playerID) !== t.partner) return INVALID

  const proposerHand = { ...G.hands[t.proposer] }
  const partnerHand = { ...G.hands[t.partner] }
  for (const r of RESOURCES) {
    if (proposerHand[r] < t.give[r] || partnerHand[r] < t.take[r]) return INVALID
    proposerHand[r] += t.take[r] - t.give[r]
    partnerHand[r] += t.give[r] - t.take[r]
  }
  G.hands[t.proposer] = proposerHand
  G.hands[t.partner] = partnerHand
  G.pendingTrade = null
  pushLog(
    G,
    `${PLAYER_NAMES[t.partner]} accepted ${countsLabel(t.give)} ⇄ ${countsLabel(t.take)} from ${PLAYER_NAMES[t.proposer]}`,
  )
  events?.endStage()
}

function declineTrade({ G, ctx, playerID, events }: MoveArgs) {
  if (!G) return INVALID
  const t = G.pendingTrade
  if (!t) return INVALID
  if (ctx.activePlayers?.[playerID as string] !== 'respond') return INVALID
  if (Number(playerID) !== t.partner) return INVALID
  G.pendingTrade = null
  pushLog(G, `${PLAYER_NAMES[t.partner]} declined the trade`)
  events?.endStage()
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
      pendingTrade: null,
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
          G.pendingTrade = null
          return G
        },
        stages: {
          discard: { moves: { discardHalf } },
          respond: { moves: { acceptTrade, declineTrade } },
        },
      },
      moves: { roll, moveRobber, steal, placeSettlement, placeRoad, upgradeCity, tradeBank, proposeTrade, endTurn },
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
export const _internals = { applyProduction, beginRobberFlow, doSteal, grantSetupResources, payCost }

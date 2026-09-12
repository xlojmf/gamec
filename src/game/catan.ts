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
import { mulberry32, shuffled } from './rng'
import {
  claimAward,
  LARGEST_ARMY_MIN,
  LONGEST_ROAD_MIN,
  longestRoadLength,
} from './awards'
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

// -- development cards (M11) ----------------------------------------------------

export type DevCardType = 'knight' | 'roadBuilding' | 'yearOfPlenty' | 'monopoly' | 'victoryPoint'

export interface DevCardEntry {
  card: DevCardType
  /** ctx.turn when purchased — playing it that same turn is illegal. */
  boughtTurn: number
}

/** Official 25-card deck: 14 knights, 2× RB/YoP/Monopoly, 5 VP (PRD §5.1). */
export const DEV_DECK_COMPOSITION: ReadonlyArray<[DevCardType, number]> = [
  ['knight', 14],
  ['roadBuilding', 2],
  ['yearOfPlenty', 2],
  ['monopoly', 2],
  ['victoryPoint', 5],
]

/** Deterministic deck order from the seed (xor-decorrelated from the board). */
export function makeDevDeck(seed: number): DevCardType[] {
  return shuffled(
    DEV_DECK_COMPOSITION.flatMap(([card, n]) => Array<DevCardType>(n).fill(card)),
    mulberry32(seed ^ 0x5eed),
  )
}

/** Display metadata for the dev-card HUD (labels/icons/hints). */
export const DEV_CARD_INFO: Record<DevCardType, { icon: string; label: string; hint: string }> = {
  knight: { icon: '⚔', label: 'Knight', hint: 'move the robber & steal 1 card' },
  roadBuilding: { icon: '🛣', label: 'Road Building', hint: 'place up to 2 free roads' },
  yearOfPlenty: { icon: '💰', label: 'Year of Plenty', hint: 'take 2 resources from the bank' },
  monopoly: { icon: '👑', label: 'Monopoly', hint: 'collect all cards of one resource' },
  victoryPoint: { icon: '🏛', label: 'Victory Point', hint: '+1 VP — counts at the win' },
}

/** Dev card purchase price (PRD §5.7). */
export const DEV_COST: Partial<ResourceCounts> = { wool: 1, grain: 1, ore: 1 }

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
  /** Fixed map preset id (src/game/maps.ts) — null/undefined = random island. */
  mapPreset?: string | null
  /** Room size (3 or 4) — sizes hands + the setup draft snake. */
  numPlayers: number
  robberTileId: string
  hands: ResourceCounts[]
  bank: ResourceCounts
  buildings: { vertices: Record<VertexId, Building>; edges: Record<EdgeId, RoadSpot> }
  /** Completed setup placements (0–8). */
  setupPlacements: number
  /** Opening-roll totals for turn order (null = not rolled yet). */
  openingRolls: (number | null)[]
  /** Seat that won the opening roll (set once every seat has rolled). */
  firstPlayer: number | null
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
  lastBuild?: { kind: 'road' | 'settlement' | 'city'; id: string; player: number; turn: number; longestRoad: GameState['longestRoad']; largestArmy: GameState['largestArmy'] } | null
  /** Remaining development deck (top = index 0). */
  devDeck: DevCardType[]
  /** Per-player dev cards in hand (VP cards stay hidden until the win). */
  devHands: DevCardEntry[][]
  /** ctx.turn of the last dev card played — one per turn. */
  devPlayedAtTurn: number
  /** Public record; only played cards are revealed, never purchases. */
  lastPlayedCard?: { player: number; card: DevCardType; turn: number; sequence: number }
  /** Revealed knights per player (Largest Army metric). */
  playedKnights: number[]
  /** Pending dev-card effect within the current turn (mirrors robberStep). */
  devStep: 'roadBuilding' | 'yearOfPlenty' | null
  /** Free roads still to place while devStep === 'roadBuilding'. */
  roadBuildingLeft: number
  longestRoad: { player: number; size: number } | null
  largestArmy: { player: number; size: number } | null
  /** Seat display names (multiplayer aliases override the color defaults). */
  playerNames: string[]
  log: string[]
  /** playerView extras (multiplayer clients only): card totals for hidden hands. */
  handSizes?: number[]
  devHandSizes?: number[]
}

/** A proposed domestic trade: proposer gives `give`, receives `take`. */
export interface PendingTrade {
  proposer: number
  partner: number
  /** Remaining recipients; omitted for a one-to-one offer and older saves. */
  partners?: number[]
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

const boardCache = new Map<string, Board>()

/** Regenerate (and cache) the island from its seed — identical everywhere. */
export function boardFor(seed: number, mapPreset?: string | null): Board {
  const key = `${seed}|${mapPreset ?? ''}`
  let board = boardCache.get(key)
  if (!board) {
    board = generateBoard(seed, mapPreset)
    boardCache.set(key, board)
  }
  return board
}

const PLAYER_NAMES = ['Red', 'Blue', 'Orange', 'White']

/** Display name for a seat — per-game names once set (multiplayer aliases). */
function pname(G: GameState, player: number): string {
  return G.playerNames?.[player] ?? PLAYER_NAMES[player] ?? `Seat ${player}`
}

/** A player's chosen display name (multiplayer): own seat only, any phase. */
function setPlayerName({ G, ctx, playerID }: MoveArgs, name: unknown) {
  if (!G) return INVALID
  const p = Number(playerID)
  if (p !== Number(ctx.currentPlayer)) return INVALID
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
  if (!clean || clean === G.playerNames[p]) return INVALID
  G.playerNames[p] = clean
}

export function vpCounts(G: GameState): number[] {
  const vps = Array.from({ length: G.hands.length }, () => 0)
  for (const b of Object.values(G.buildings.vertices)) vps[b.player] += b.type === 'city' ? 2 : 1
  for (let p = 0; p < G.hands.length; p++) {
    // VP dev cards count toward the win (revealed on the spot) — PRD §5.6
    vps[p] += G.devHands[p].filter((c) => c.card === 'victoryPoint').length
  }
  if (G.longestRoad) vps[G.longestRoad.player] += 2
  if (G.largestArmy) vps[G.largestArmy.player] += 2
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
  const board = boardFor(G.seed, G.mapPreset)
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
  const board = boardFor(G.seed, G.mapPreset)
  const out: VertexId[] = []
  for (const v of board.vertices) {
    if (G.buildings.vertices[v.id]) continue
    if (respectsDistance(G, board, v.id)) out.push(v.id)
  }
  return out
}

/** Empty road spots touching the just-placed setup settlement. */
export function validSetupEdges(G: GameState, vertexId: VertexId): EdgeId[] {
  const board = boardFor(G.seed, G.mapPreset)
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

/** Fully legal road spots: empty, connected, supply remaining (no cost —
 *  also the Road Building effect's placement rule). */
export function connectedRoadEdges(G: GameState, player: number): EdgeId[] {
  const board = boardFor(G.seed, G.mapPreset)
  if (pieceCounts(G, player).road >= SUPPLY_LIMITS.road) return []
  const out: EdgeId[] = []
  for (const e of board.edges) {
    if (G.buildings.edges[e.id]) continue
    if (e.vertexIds.some((vid) => connectsThrough(G, board, vid, player))) out.push(e.id)
  }
  return out
}

/** Fully legal *paid* road spots: connected + affordable. */
export function validRoadEdges(G: GameState, player: number): EdgeId[] {
  if (!canAfford(G.hands[player], BUILD_COSTS.road)) return []
  return connectedRoadEdges(G, player)
}

/** Fully legal settlement spots: empty, distance rule, own road, affordable, supply. */
export function validSettlementVertices(G: GameState, player: number): VertexId[] {
  const board = boardFor(G.seed, G.mapPreset)
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
  const board = boardFor(G.seed, G.mapPreset)
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
  G.lastBuild = null
  G.log.unshift(text)
}

/** Apply production for a roll, updating hands + bank (PRD §5.3.1). */
function applyProduction(G: GameState, sum: number, turn: number) {
  const board = boardFor(G.seed, G.mapPreset)
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
  for (const d of discarders) pushLog(G, `${pname(G, d.p)} must discard ${d.required}`)
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
  pushLog(G, `${pname(G, thief)} stole a card from ${pname(G, victim)}`)
  return card
}

/** Recompute Longest Road / Largest Army after board- or knight-changing moves. */
function updateAwards(G: GameState) {
  const board = boardFor(G.seed, G.mapPreset)
  const lengths = G.hands.map((_, p) => longestRoadLength(G.buildings, board, p))
  G.longestRoad = claimAward(G.longestRoad, lengths, LONGEST_ROAD_MIN)
  G.largestArmy = claimAward(G.largestArmy, G.playedKnights, LARGEST_ARMY_MIN)
}

/** Second-round setup settlements collect 1 card per adjacent producing hex. */
function grantSetupResources(G: GameState, player: number, vertexId: VertexId) {
  const board = boardFor(G.seed, G.mapPreset)
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

/**
 * Opening roll (PRD §5.2): every seat throws the dice; the highest total
 * decides who places first (ties re-roll, official rule). Each player acts on
 * their own turn; the phase ends when every seat has a total.
 */
function openingRoll({ G, ctx, playerID, random, events }: MoveArgs) {
  if (!G) return INVALID
  const p = Number(playerID)
  if (p !== Number(ctx.currentPlayer)) return INVALID
  if (G.firstPlayer !== null || G.openingRolls[p] !== null) return INVALID

  let die1 = random!.Die(6)
  let die2 = random!.Die(6)
  let sum = die1 + die2
  // tie → re-roll until the total is unique (bounded for safety)
  const taken = new Set(G.openingRolls.filter((r): r is number => r !== null))
  for (let guard = 0; taken.has(sum) && guard < 40; guard++) {
    die1 = random!.Die(6)
    die2 = random!.Die(6)
    sum = die1 + die2
  }
  G.openingRolls[p] = sum
  G.lastRoll = { die1, die2, sum, nonce: ctx.turn }
  pushLog(G, `${pname(G, p)} rolled ${sum} for turn order`)

  if (G.openingRolls.every((r) => r !== null)) {
    let best = 0
    G.openingRolls.forEach((r, i) => {
      if ((r ?? 0) > (G.openingRolls[best] ?? 0)) best = i
    })
    G.firstPlayer = best
    pushLog(G, `${pname(G, best)} rolled highest — ${pname(G, best)} starts`)
  }
  events?.endTurn()
}

function placeSetup({ G, ctx, events }: MoveArgs, vertexId: VertexId, edgeId: EdgeId) {
  if (!G) return INVALID
  const player = Number(ctx.currentPlayer)
  const board = boardFor(G.seed, G.mapPreset)
  const vertex = board.vertexById.get(vertexId)
  const edge = board.edgeById.get(edgeId)
  if (!vertex || !edge) return INVALID
  if (G.buildings.vertices[vertexId] || G.buildings.edges[edgeId]) return INVALID
  if (!edge.vertexIds.includes(vertexId)) return INVALID // road must touch the settlement
  if (!validSetupVertices(G).includes(vertexId)) return INVALID // empty + distance rule

  G.buildings.vertices[vertexId] = { player, type: 'settlement' }
  G.buildings.edges[edgeId] = { player }
  const secondRound = G.setupPlacements >= (G.numPlayers ?? 4)
  G.setupPlacements++
  pushLog(G, `${pname(G, player)} placed a settlement${secondRound ? ' (2nd)' : ''} + road`)
  if (secondRound) grantSetupResources(G, player, vertexId)
  updateAwards(G)

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
  pushLog(G, `${pname(G, player)} discarded ${required}`)
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
  const board = boardFor(G.seed, G.mapPreset)
  if (!board.tileById.has(tileId)) return INVALID

  G.robberTileId = tileId
  pushLog(G, `${pname(G, Number(ctx.currentPlayer))} moved the robber`)
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
  if (!G.rolled || G.robberStep || G.devStep) return INVALID
  const player = Number(ctx.currentPlayer)
  if (!validSettlementVertices(G, player).includes(vertexId)) return INVALID
  const undo = buildUndo(G, ctx, 'settlement', vertexId)
  payCost(G, player, BUILD_COSTS.settlement)
  G.buildings.vertices[vertexId] = { player, type: 'settlement' }
  pushLog(G, `${pname(G, player)} built a settlement (${costLabel(BUILD_COSTS.settlement)})`)
  updateAwards(G) // a new settlement can cut an opponent's road
  G.lastBuild = undo
}

function placeRoad({ G, ctx }: MoveArgs, edgeId: EdgeId) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep || G.devStep) return INVALID
  const player = Number(ctx.currentPlayer)
  if (!validRoadEdges(G, player).includes(edgeId)) return INVALID
  const undo = buildUndo(G, ctx, 'road', edgeId)
  payCost(G, player, BUILD_COSTS.road)
  G.buildings.edges[edgeId] = { player }
  pushLog(G, `${pname(G, player)} built a road (${costLabel(BUILD_COSTS.road)})`)
  updateAwards(G)
  G.lastBuild = undo
}

function upgradeCity({ G, ctx }: MoveArgs, vertexId: VertexId) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep || G.devStep) return INVALID
  const player = Number(ctx.currentPlayer)
  if (!validCityVertices(G, player).includes(vertexId)) return INVALID
  const undo = buildUndo(G, ctx, 'city', vertexId)
  payCost(G, player, BUILD_COSTS.city)
  G.buildings.vertices[vertexId] = { player, type: 'city' }
  pushLog(G, `${pname(G, player)} upgraded a city (${costLabel(BUILD_COSTS.city)})`)
  updateAwards(G)
  G.lastBuild = undo
}

function buildUndo(G: GameState, ctx: CtxShape, kind: 'road' | 'settlement' | 'city', id: string): NonNullable<GameState['lastBuild']> {
  return { kind, id, player: Number(ctx.currentPlayer), turn: ctx.turn,
    longestRoad: G.longestRoad ? { ...G.longestRoad } : null,
    largestArmy: G.largestArmy ? { ...G.largestArmy } : null }
}

/** Only the most recent paid placement, before any subsequent logged action. */
function undoBuild({ G, ctx }: MoveArgs) {
  const undo = G?.lastBuild
  if (!G || !undo || undo.player !== Number(ctx.currentPlayer) || undo.turn !== ctx.turn || G.pendingTrade || G.robberStep || G.devStep) return INVALID
  const cost = BUILD_COSTS[undo.kind]
  if (RESOURCES.some(r => G.bank[r] < (cost[r] ?? 0))) return INVALID
  if (undo.kind === 'road') delete G.buildings.edges[undo.id]
  else if (undo.kind === 'city') G.buildings.vertices[undo.id] = {player: undo.player, type: 'settlement'}
  else delete G.buildings.vertices[undo.id]
  for (const r of RESOURCES) { G.bank[r] -= cost[r] ?? 0; G.hands[undo.player][r] += cost[r] ?? 0 }
  G.longestRoad = undo.longestRoad
  G.largestArmy = undo.largestArmy
  pushLog(G, `${pname(G, undo.player)} undid the last ${undo.kind}; resources returned`)
}

// -- development cards (M11) -------------------------------------------------------

function buyDevCard({ G, ctx }: MoveArgs) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep || G.pendingTrade || G.devStep) return INVALID
  if (G.devDeck.length === 0) return INVALID
  const player = Number(ctx.currentPlayer)
  if (!canAfford(G.hands[player], DEV_COST)) return INVALID

  payCost(G, player, DEV_COST)
  const card = G.devDeck[0]
  G.devDeck = G.devDeck.slice(1)
  G.devHands[player] = [...G.devHands[player], { card, boughtTurn: ctx.turn }]
  pushLog(G, `${pname(G, player)} bought a development card (${G.devDeck.length} left)`) // draw stays secret
  // a VP card may complete 10 VP — endIf checks vpCounts right after this move
}

/** Shared playability gate; returns the entry if playable. */
function devCardPlayable(G: GameState, player: number, ctxTurn: number, index: number): DevCardEntry | null {
  const entry = G.devHands[player]?.[index]
  if (!entry) return null
  if (entry.card === 'victoryPoint') return null // VP cards count automatically, never "played"
  // dev cards may be played before OR after rolling (official rules) — e.g. a
  // Knight before the throw. The robber flow simply blocks the roll until it
  // resolves (the `roll` move rejects while robberStep is set).
  if (G.robberStep || G.pendingTrade || G.devStep) return null
  if (G.devPlayedAtTurn === ctxTurn) return null // at most one dev card per turn
  if (entry.boughtTurn === ctxTurn) return null // never the card bought this turn
  return entry
}

function playDevCard({ G, ctx }: MoveArgs, index: number, monopolyResource?: Resource) {
  if (!G) return INVALID
  const player = Number(ctx.currentPlayer)
  const entry = devCardPlayable(G, player, ctx.turn, index)
  if (!entry) return INVALID
  if (entry.card === 'monopoly' && (!monopolyResource || !RESOURCES.includes(monopolyResource))) return INVALID

  G.devHands[player] = G.devHands[player].filter((_, i) => i !== index)
  G.devPlayedAtTurn = ctx.turn
  G.lastPlayedCard = { player, card: entry.card, turn: ctx.turn, sequence: (G.lastPlayedCard?.sequence ?? 0) + 1 }

  switch (entry.card) {
    case 'knight': {
      G.playedKnights[player]++
      pushLog(G, `${pname(G, player)} played a Knight (${G.playedKnights[player]} total)`)
      updateAwards(G)
      G.robberStep = 'move' // reuse the standard robber flow (no discard step)
      break
    }
    case 'roadBuilding': {
      pushLog(G, `${pname(G, player)} played Road Building — place up to 2 free roads`)
      G.devStep = 'roadBuilding'
      G.roadBuildingLeft = 2
      if (connectedRoadEdges(G, player).length === 0) {
        G.devStep = null // nowhere to build — effect fizzles
        G.roadBuildingLeft = 0
      }
      break
    }
    case 'yearOfPlenty': {
      pushLog(G, `${pname(G, player)} played Year of Plenty`)
      G.devStep = 'yearOfPlenty'
      break
    }
    case 'monopoly': {
      const r = monopolyResource!
      let collected = 0
      for (let p = 0; p < G.hands.length; p++) {
        if (p === player) continue
        collected += G.hands[p][r]
        const hand = { ...G.hands[p] }
        hand[r] = 0
        G.hands[p] = hand
      }
      const hand = { ...G.hands[player] }
      hand[r] += collected
      G.hands[player] = hand
      pushLog(G, `${pname(G, player)} monopolized ${RESOURCE_ICONS[r]} — collected ${collected}`)
      break
    }
  }
}

/** Place one of Road Building's free roads (normal placement rules, no cost). */
function placeFreeRoad({ G, ctx }: MoveArgs, edgeId: EdgeId) {
  if (!G) return INVALID
  if (G.devStep !== 'roadBuilding' || G.roadBuildingLeft <= 0) return INVALID
  const player = Number(ctx.currentPlayer)
  if (!connectedRoadEdges(G, player).includes(edgeId)) return INVALID

  G.buildings.edges[edgeId] = { player }
  G.roadBuildingLeft--
  pushLog(G, `${pname(G, player)} placed a free road (${G.roadBuildingLeft} left)`)
  updateAwards(G)
  if (G.roadBuildingLeft === 0 || connectedRoadEdges(G, player).length === 0) {
    G.devStep = null
    G.roadBuildingLeft = 0
  }
}

/** Forfeit remaining free roads so the turn can continue. */
function finishRoadBuilding({ G }: MoveArgs) {
  if (!G || G.devStep !== 'roadBuilding') return INVALID
  G.devStep = null
  G.roadBuildingLeft = 0
  pushLog(G, 'Finished Road Building')
}

function takeYearOfPlenty({ G, ctx }: MoveArgs, r1: Resource, r2: Resource) {
  if (!G) return INVALID
  if (G.devStep !== 'yearOfPlenty') return INVALID
  if (!RESOURCES.includes(r1) || !RESOURCES.includes(r2)) return INVALID
  const need = emptyResourceCounts()
  need[r1] += 1
  need[r2] += 1
  for (const r of RESOURCES) {
    if (need[r] > G.bank[r]) return INVALID // empty-stack rule
  }
  const player = Number(ctx.currentPlayer)
  const hand = { ...G.hands[player] }
  const bank = { ...G.bank }
  for (const r of RESOURCES) {
    hand[r] += need[r]
    bank[r] -= need[r]
  }
  G.hands[player] = hand
  G.bank = bank
  G.devStep = null
  pushLog(G, `${pname(G, player)} took ${countsLabel(need)} from the bank (Year of Plenty)`)
}

/** Maritime trade: give `rate` of one resource for 1 of another (PRD §5.3.2). */
function tradeBank({ G, ctx }: MoveArgs, give: Resource, take: Resource) {
  if (!G) return INVALID
  if (!RESOURCES.includes(give) || !RESOURCES.includes(take)) return INVALID
  if (!G.rolled || G.robberStep || G.pendingTrade || G.devStep) return INVALID
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
  pushLog(G, `${pname(G, player)} traded ${rate}${RESOURCE_ICONS[give]} for 1${RESOURCE_ICONS[take]}${via}`)
}

function proposeTrade(
  { G, ctx, events }: MoveArgs,
  partnerId: number | number[],
  give: Partial<ResourceCounts>,
  take: Partial<ResourceCounts>,
) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep || G.pendingTrade || G.devStep) return INVALID
  const proposer = Number(ctx.currentPlayer)
  let partners = Array.isArray(partnerId) ? [...new Set(partnerId)] : [partnerId]
  if (!partners.length || partners.some(p => !Number.isInteger(p) || p === proposer || p < 0 || p >= G.hands.length)) return INVALID

  const normGive = emptyResourceCounts()
  const normTake = emptyResourceCounts()
  let giveTotal = 0
  let takeTotal = 0
  for (const r of RESOURCES) {
    const g = give[r] ?? 0
    const t = take[r] ?? 0
    if (!Number.isInteger(g) || !Number.isInteger(t) || g < 0 || t < 0) return INVALID
    if (g > 0 && t > 0) return INVALID // may not trade identical resources
    if (g > G.hands[proposer][r]) return INVALID
    normGive[r] = g
    normTake[r] = t
    giveTotal += g
    takeTotal += t
  }
  if (giveTotal < 1 || takeTotal < 1) return INVALID
  // NOTE: recipients are deliberately NOT filtered by whether they can cover
  // `take` — every selected partner must SEE the offer (they can decline or
  // counter) so nobody can infer that a player lacks a resource from the
  // offer never reaching them. acceptTrade re-validates both hands at
  // acceptance time. This also keeps client-side validation consistent in
  // multiplayer, where other players' hands are masked to zeros by playerView.

  G.pendingTrade = { proposer, partner: partners[0], give: normGive, take: normTake, ...(partners.length > 1 ? {partners} : {}) }
  pushLog(
    G,
    `${pname(G, proposer)} offers ${partners.map(p => pname(G, p)).join(', ')}: ${countsLabel(normGive)} for ${countsLabel(normTake)}`,
  )
  events?.setActivePlayers({ value: Object.fromEntries(partners.map(p => [String(p), {stage: 'respond'}])) })
}

function acceptTrade({ G, ctx, playerID, events }: MoveArgs) {
  if (!G) return INVALID
  const t = G.pendingTrade
  if (!t) return INVALID
  if (ctx.activePlayers?.[playerID as string] !== 'respond') return INVALID
  const partner = Number(playerID)
  if (!(t.partners ?? [t.partner]).includes(partner)) return INVALID

  const proposerHand = { ...G.hands[t.proposer] }
  const partnerHand = { ...G.hands[partner] }
  for (const r of RESOURCES) {
    if (proposerHand[r] < t.give[r] || partnerHand[r] < t.take[r]) return INVALID
    proposerHand[r] += t.take[r] - t.give[r]
    partnerHand[r] += t.give[r] - t.take[r]
  }
  G.hands[t.proposer] = proposerHand
  G.hands[partner] = partnerHand
  G.pendingTrade = null
  pushLog(
    G,
    `${pname(G, partner)} accepted ${countsLabel(t.give)} ⇄ ${countsLabel(t.take)} from ${pname(G, t.proposer)}`,
  )
  if (t.partners) events?.setActivePlayers({ value: {} })
  else events?.endStage()
}

function declineTrade({ G, ctx, playerID, events }: MoveArgs) {
  if (!G) return INVALID
  const t = G.pendingTrade
  if (!t) return INVALID
  if (ctx.activePlayers?.[playerID as string] !== 'respond') return INVALID
  const partner = Number(playerID)
  if (!(t.partners ?? [t.partner]).includes(partner)) return INVALID
  const remaining = (t.partners ?? [t.partner]).filter(p => p !== partner)
  G.pendingTrade = remaining.length ? { ...t, partner: remaining[0], partners: remaining } : null
  pushLog(G, `${pname(G, partner)} declined the trade`)
  events?.endStage()
}

/** A counter replaces the pending offer with a one-to-one negotiation. */
function counterTrade({ G, ctx, playerID, events }: MoveArgs, give: Partial<ResourceCounts>, take: Partial<ResourceCounts>) {
  const pending = G?.pendingTrade
  const proposer = Number(playerID)
  if (!G || !pending || ctx.activePlayers?.[playerID as string] !== 'respond' || !(pending.partners ?? [pending.partner]).includes(proposer)) return INVALID
  const partner = pending.proposer
  const normGive = emptyResourceCounts(), normTake = emptyResourceCounts()
  for (const r of RESOURCES) {
    const g = give[r] ?? 0, t = take[r] ?? 0
    if (!Number.isInteger(g) || !Number.isInteger(t) || g < 0 || t < 0 || (g > 0 && t > 0) || g > G.hands[proposer][r] || t > G.hands[partner][r]) return INVALID
    normGive[r] = g; normTake[r] = t
  }
  if (totalCards(normGive) < 1 || totalCards(normTake) < 1) return INVALID
  G.pendingTrade = {proposer, partner, give: normGive, take: normTake}
  pushLog(G, `${pname(G, proposer)} countered ${pname(G, partner)}: ${countsLabel(normGive)} for ${countsLabel(normTake)}`)
  events?.setActivePlayers({value: {[String(partner)]: {stage: 'respond'}}})
}

function endTurn({ G, events }: MoveArgs) {
  if (!G) return INVALID
  if (!G.rolled || G.robberStep) return INVALID
  if (G.devStep) {
    // "up to 2" free roads — unplaced ones are forfeited
    G.devStep = null
    G.roadBuildingLeft = 0
  }
  events?.endTurn()
}

// -- game definition -----------------------------------------------------------

/**
 * Snake draft order from the opening-roll winner: placements 0..n-1 go
 * clockwise from `firstPlayer`, placements n..2n-1 come back (so the winner
 * also places LAST and therefore opens the main phase — official rules).
 * Position is derived from G.setupPlacements, not ctx.turn — turn numbers
 * differ between hotseat (setup starts at turn 1) and multiplayer (after the
 * opening-roll phase).
 */
const setupOrder = {
  first: ({ G }: { G?: GameState }) => G?.firstPlayer ?? 0,
  next: ({ G }: { G?: GameState }) => {
    const n = G?.numPlayers ?? 4
    const f = G?.firstPlayer ?? 0
    // setupPlacements is already incremented when endTurn fires, so it IS the
    // 0-based index of the placement `next` is picking. Clamp so the final
    // endTurn still yields a valid seat (endIf fires before it's used).
    const i = Math.min(G?.setupPlacements ?? 0, 2 * n - 1)
    return i < n ? (f + i) % n : (f + (2 * n - 1 - i)) % n
  },
}

/** Main phase: the last setup placer (the opening-roll winner) starts, then clockwise. */
const mainOrder = {
  first: ({ ctx }: { ctx: { playOrderPos: number } }) => ctx.playOrderPos,
  next: ({ ctx }: { ctx: { playOrderPos: number; playOrder: string[] } }) =>
    (ctx.playOrderPos + 1) % ctx.playOrder.length,
}

/**
 * Game definition factory. `openingRoll` adds the official start (every seat
 * throws, highest places first) as a phase before the setup draft — used by
 * the multiplayer server. Hotseat skips it for a quick start (and so the
 * local tests keep their deterministic player-0 start).
 */
function catanGameConfig({ openingRoll: withOpeningRoll }: { openingRoll: boolean }) {
  return {
    name: 'catan-3d' as const,
    setup(_ctx: unknown, setupData: { seed?: number; numPlayers?: number; playerNames?: string[]; mapPreset?: string | null } | undefined): GameState {
      const seed = setupData?.seed ?? 1
      const mapPreset = setupData?.mapPreset ?? null
      const numPlayers = setupData?.numPlayers === 3 ? 3 : 4
      const board = boardFor(seed, mapPreset)
      const names = Array.from({ length: numPlayers }, (_, i) =>
        setupData?.playerNames?.[i]?.replace(/\s+/g, ' ').trim().slice(0, 24) || PLAYER_NAMES[i],
      )
      return {
        seed,
        mapPreset,
        numPlayers,
        robberTileId: board.desertTileId,
        hands: Array.from({ length: numPlayers }, () => emptyResourceCounts()),
        bank: { ...BANK_START },
        buildings: { vertices: {}, edges: {} },
        setupPlacements: 0,
        openingRolls: Array.from({ length: numPlayers }, () => null),
        firstPlayer: null,
        rolled: false,
        lastRoll: null,
        lastProduction: null,
        robberStep: null,
        pendingDiscards: {},
        stealTargets: null,
        pendingTrade: null,
        devDeck: makeDevDeck(seed),
        devHands: Array.from({ length: numPlayers }, () => []),
        devPlayedAtTurn: -1,
        playedKnights: Array.from({ length: numPlayers }, () => 0),
        devStep: null,
        roadBuildingLeft: 0,
        longestRoad: null,
        largestArmy: null,
        playerNames: names,
        log: [],
      }
    },

    phases: {
      ...(withOpeningRoll
        ? {
            openingRoll: {
              start: true,
              turn: {
                order: {
                  first: () => 0,
                  next: ({ ctx }: { ctx: { playOrderPos: number; playOrder: string[] } }) =>
                    (ctx.playOrderPos + 1) % ctx.playOrder.length,
                },
              },
              moves: { openingRoll, setPlayerName },
              endIf: ({ G }: { G?: GameState }) => G?.firstPlayer != null,
              next: 'setup',
            },
          }
        : {}),
      setup: {
        start: !withOpeningRoll,
        turn: { order: setupOrder },
        moves: { placeSetup, setPlayerName },
        endIf: ({ G }: { G?: GameState }) => (G?.setupPlacements ?? 0) >= (G?.numPlayers ?? 4) * 2,
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
            G.lastBuild = null
            G.devStep = null
            G.roadBuildingLeft = 0
            G.devPlayedAtTurn = -1
            return G
          },
          stages: {
            discard: { moves: { discardHalf } },
            respond: { moves: { acceptTrade, declineTrade, counterTrade } },
          },
        },
        moves: {
          roll,
          moveRobber,
          steal,
          placeSettlement,
          placeRoad,
          upgradeCity,
          undoBuild,
          tradeBank,
          proposeTrade,
          buyDevCard,
          playDevCard,
          placeFreeRoad,
          finishRoadBuilding,
          takeYearOfPlenty,
          endTurn,
          setPlayerName,
        },
      },
    },

    endIf: ({ G, ctx }: { G?: GameState; ctx?: { currentPlayer?: string } }) => {
      if (!G?.hands) return undefined
      // official rule: you reach 10 VP on YOUR turn (awards you lose while
      // someone else acts can never hand them the win, and vice versa)
      const current = Number(ctx?.currentPlayer ?? '0')
      const vps = vpCounts(G)
      return vps[current] >= VICTORY_POINTS ? { winner: current } : undefined
    },

    playerView: ({ G, ctx, playerID }: { G?: GameState; ctx?: { gameover?: unknown }; playerID?: string | null }) => {
      if (!G) return G
      // game over → open the books: final hands & dev cards are revealed so the
      // win screen shows true totals (official “reveal at the end” behavior)
      if (ctx?.gameover) return G
      const n = Number(playerID)
      return maskGameState(G, playerID != null && Number.isInteger(n) && n >= 0 ? n : null)
    },
  }
}

/** The full online game — includes the opening-roll phase (server path). */
export const CatanGame = catanGameConfig({ openingRoll: true })

/**
 * Multiplayer secret-state filter (PRD §7): a client only ever receives its own
 * hand and dev cards. Other players' cards collapse to sizes (so the HUD can
 * still show totals) and the deck order is hidden from everyone. The hotseat
 * factory below strips playerView entirely — hotseat is open information.
 */
function maskGameState(G: GameState, pid: number | null): GameState {
  return {
    ...G,
    hands: G.hands.map((h, i) => (i === pid ? h : emptyResourceCounts())),
    devHands: G.devHands.map((d, i) => (i === pid ? d : [])),
    devDeck: G.devDeck.map(() => 'victoryPoint' as DevCardType),
    handSizes: G.hands.map(totalCards),
    devHandSizes: G.devHands.map((d) => d.length),
  }
}

/**
 * Local hotseat factory: boardgame.io 0.50's local client doesn't forward
 * `setupData` (only the multiplayer server does), so we close over the seed.
 * Hotseat skips the opening-roll phase (quick start, deterministic tests) and
 * keeps hands open (playerView stripped).
 */
export function createCatanGame(seed: number, numPlayers: number = 4, mapPreset?: string | null) {
  const { playerView: _hiddenForMultiplayer, ...openInformation } = catanGameConfig({ openingRoll: false })
  return {
    ...openInformation,
    setup(ctx: unknown) {
      return CatanGame.setup(ctx, { seed, numPlayers, mapPreset })
    },
  }
}

// exported for unit tests (exercised through the client in integration tests)
export const _internals = { applyProduction, beginRobberFlow, doSteal, grantSetupResources, payCost }

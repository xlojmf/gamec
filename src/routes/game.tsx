import { ResourceIcon } from '#/components/ResourceIcon'
import { GameAudioProvider, SoundToggle, Soundboard } from '#/components/GameSound'
import { HandTray } from '#/components/HandTray'
import { GameIcon, DevCardIcon } from '#/components/GameIcon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Client } from 'boardgame.io/client'
import { SocketIO } from 'boardgame.io/multiplayer'
import { GameCanvas, type ProductionReport, type RollTrigger } from '#/components/GameCanvas'
import {
  PLAYER_COLORS,
  PLAYER_COUNT,
  PLAYER_NAMES,
  type BuildKind,
  type BuildMode,
  type HoverInfo,
  type PickTarget,
  type PlacementState,
} from '#/three/GameView'
import { generateBoard } from '#/game/board'
import { mapPresetById } from '#/game/maps'
import { randomSeed } from '#/game/rng'
import { isRobberRoll, type DiceRoll } from '#/game/dice'
import {
  BUILD_COSTS,
  CatanGame,
  DEV_CARD_INFO,
  DEV_COST,
  SUPPLY_LIMITS,
  bankTradeRate,
  connectedRoadEdges,
  countsLabel,
  createCatanGame,
  pieceCounts,
  validCityVertices,
  validRoadEdges,
  validSetupEdges,
  validSetupVertices,
  validSettlementVertices,
  vpCounts,
  type BgioState,
} from '#/game/catan'
import {
  RESOURCE_ICONS,
  RESOURCE_LABELS,
  RESOURCES,
  TERRAIN_INFO,
  TERRAIN_COUNTS,
  totalCards,
  type Resource,
  type ResourceCounts,
} from '#/game/terrain'
import { gameServerHost, loadCreatorToken, loadMpSession, roomsApiBase, type MpSession } from '#/multiplayer/session'
import { staleSyncGuard } from '#/multiplayer/transport'

export const Route = createFileRoute('/game')({
  validateSearch: (search: Record<string, unknown>): { match?: string; seat?: number; server?: string; players?: number; map?: string } => {
    // numbers may come back as strings after a hard refresh — coerce
    const num = (v: unknown) =>
      typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined
    return {
      match: typeof search.match === 'string' ? search.match : undefined,
      seat: num(search.seat),
      server: typeof search.server === 'string' ? search.server : undefined,
      players: num(search.players),
      map: typeof search.map === 'string' ? search.map : undefined,
    }
  },
  component: GamePage,
})

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')


/** Display name for a seat — the game's multiplayer alias, or the color default. */
const pname = (G: { playerNames?: string[] } | null | undefined, i: number) =>
  G?.playerNames?.[i] ?? PLAYER_NAMES[i]

/** Static island legend — module-level so no hook ordering can break. */
const TERRAIN_LEGEND = TERRAIN_COUNTS.map(([terrain, count]) => ({ terrain, count }))

function DieFace({ v }: { v: number }) {
  return <img className="die-face" src={`/assets/astra/ui/dice-${v}.svg`} alt={`Die showing ${v}`} />
}

type BgioClient = ReturnType<typeof Client>

/** Which brain GamePage owns: a local hotseat island or a server match. */
export type ClientConfig =
  | { kind: 'hotseat'; seed: number; numPlayers?: number; mapPreset?: string | null }
  | { kind: 'mp'; matchID: string; seat: number; credentials: string; server: string; numPlayers?: number }

/** Owns one boardgame.io client per config — the whole game's brain. */
function useCatanClient(config: ClientConfig | null) {
  const [state, setState] = useState<BgioState | null>(null)
  const clientRef = useRef<BgioClient | null>(null)
  /** Multiplayer seats are fixed — moves always dispatch as this player. */
  const fixedSeat = config?.kind === 'mp' ? config.seat : null

  useEffect(() => {
    if (!config) return
    const client: BgioClient =
      config.kind === 'mp'
        ? Client({
            debug: false,
            game: CatanGame,
            numPlayers: config.numPlayers ?? 4,
            playerID: String(config.seat),
            matchID: config.matchID,
            credentials: config.credentials,
            multiplayer: staleSyncGuard(SocketIO({ server: config.server })),
          })
        : Client({ debug: false, game: createCatanGame(config.seed, config.numPlayers ?? 4, config.mapPreset), numPlayers: config.numPlayers ?? PLAYER_COUNT })
    client.start()
    clientRef.current = client
    setState(client.getState() as BgioState)
    const unsubscribe = client.subscribe((s) => {
      if (s) setState(s as unknown as BgioState)
    })
    return () => {
      unsubscribe()
      client.stop()
      clientRef.current = null
    }
  }, [config])

  /**
   * Dispatch a move as the given player (hotseat acts for everyone; mp is fixed).
   * Only switch playerID when it actually changes: in multiplayer the seat is
   * fixed for the client's lifetime, and boardgame.io's updatePlayerID emits a
   * full-state `sync` request. Calling it on every move made the stale sync
   * response race the move's broadcast — the local client could be rolled back
   * to the pre-move state for seconds while every other player updated instantly.
   */
  const move = useCallback(
    (pid: number, fn: (moves: Record<string, (...args: unknown[]) => unknown>) => void) => {
      const client = clientRef.current
      if (!client) return
      const target = String(fixedSeat ?? pid)
      if (client.playerID !== target) client.updatePlayerID(target)
      fn(client.moves as Record<string, (...args: unknown[]) => unknown>)
    },
    [fixedSeat],
  )

  return { state, move }
}

/** Discard-half overlay: pick exactly `required` cards. */
function DiscardPanel({
  player,
  playerName,
  hand,
  required,
  onConfirm,
}: {
  player: number
  playerName: string
  hand: ResourceCounts
  required: number
  onConfirm: (cards: Partial<ResourceCounts>) => void
}) {
  const [sel, setSel] = useState<Partial<ResourceCounts>>({})
  const total = RESOURCES.reduce((n, r) => n + (sel[r] ?? 0), 0)
  return (
    <div className="overlay">
      <div className="overlay-card">
        <h3>
          <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[player]) } as React.CSSProperties} />{' '}
          {playerName} — discard {required} card{required === 1 ? '' : 's'}
        </h3>
        <div className="discard-grid">
          {RESOURCES.map((r) => (
            <div key={r} className="discard-cell">
              <span className="discard-label">
                {<ResourceIcon resource={r} />} {RESOURCE_LABELS[r]} ×{hand[r]}
              </span>
              <div className="stepper">
                <button
                  className="btn btn-small"
                  disabled={(sel[r] ?? 0) === 0}
                  onClick={() => setSel((s) => ({ ...s, [r]: (s[r] ?? 0) - 1 }))}
                >
                  −
                </button>
                <span className="stepper-value">{sel[r] ?? 0}</span>
                <button
                  className="btn btn-small"
                  disabled={(sel[r] ?? 0) >= hand[r]}
                  onClick={() => setSel((s) => ({ ...s, [r]: (s[r] ?? 0) + 1 }))}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
        <button className="btn btn-primary" disabled={total !== required} onClick={() => onConfirm(sel)}>
          Discard {total}/{required}
        </button>
      </div>
    </div>
  )
}

/** Cost line for build buttons; resources the player lacks turn red. */
function CostTag({ cost, hand }: { cost: Partial<ResourceCounts>; hand: ResourceCounts }) {
  return (
    <span className="build-cost">
      {RESOURCES.filter((r) => cost[r]).map((r) => (
        <span key={r} className={hand[r] >= (cost[r] ?? 0) ? '' : 'lack'}>
          {<ResourceIcon resource={r} />}
          {cost[r]}
        </span>
      ))}
    </span>
  )
}

/** Tiny labelled −/value/+ stepper for trade offers. */
function Stepper({
  value,
  max,
  label,
  onChange,
}: {
  value: number
  max: number
  label: string
  onChange: (v: number) => void
}) {
  return (
    <span className="trade-step">
      <span className="trade-step-label">{label}</span>
      <button className="btn btn-small" disabled={value === 0} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span className="stepper-value">{value}</span>
      <button className="btn btn-small" disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </span>
  )
}

/** Domestic trade composer: pick a partner + terms, then propose. */
function TradeOfferPanel({
  proposer,
  names,
  hands,
  onPropose,
  onClose,
  target,
  initialGive,
  initialTake,
}: {
  proposer: number
  /** Seat display names (multiplayer aliases). */
  names: string[]
  /** null = hidden hand (multiplayer) — totals unknown, offers capped at 4. */
  hands: (ResourceCounts | null)[]
  onPropose: (partner: number | number[], give: Partial<ResourceCounts>, take: Partial<ResourceCounts>) => void
  onClose: () => void
  target?: number
  initialGive?: Partial<ResourceCounts>
  initialTake?: Partial<ResourceCounts>
}) {
  const [partner, setPartner] = useState<number | null>(target ?? null)
  const [give, setGive] = useState<Partial<ResourceCounts>>(initialGive ?? {})
  const [take, setTake] = useState<Partial<ResourceCounts>>(initialTake ?? {})
  const ownHand = hands[proposer]!
  const giveTotal = RESOURCES.reduce((n, r) => n + (give[r] ?? 0), 0)
  const takeTotal = RESOURCES.reduce((n, r) => n + (take[r] ?? 0), 0)
  const overlap = RESOURCES.some((r) => (give[r] ?? 0) > 0 && (take[r] ?? 0) > 0)
  const valid = partner !== null && giveTotal >= 1 && takeTotal >= 1 && !overlap

  return (
    <div className="overlay">
      <div className="overlay-card">
        <h3>
          <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[proposer]) } as React.CSSProperties} />{' '}
          {names[proposer]} — propose a trade
        </h3>
        <div className="trade-partners">
          {hands.map((_, p) =>
            p !== proposer && (target === undefined || target === p) ? (
              <button
                key={p}
                className={`chip ${partner === p ? 'chip-active' : ''}`}
                style={{ '--chip': hex(PLAYER_COLORS[p]) } as React.CSSProperties}
                onClick={() => {
                  setPartner(p)
                  setTake({})
                }}
              >
                <span className="chip-dot" />
                {names[p]}
              </button>
            ) : null,
          )}
          {target === undefined && <button className={`chip ${partner === -1 ? 'chip-active' : ''}`} onClick={() => {setPartner(-1); setTake({})}}>Anyone at the table</button>}
        </div>
        <div className="trade-grid">
          {RESOURCES.map((r) => (
            <div key={r} className="discard-cell">
              <span className="discard-label">
                {<ResourceIcon resource={r} />} {RESOURCE_LABELS[r]}
                <span className="muted small">
                  {' '}
                  you {ownHand[r]} · them {partner !== null ? (hands[partner] ? hands[partner]![r] : '??') : '—'}
                </span>
              </span>
              <div className="trade-steppers">
                <Stepper
                  value={give[r] ?? 0}
                  max={ownHand[r]}
                  label="give"
                  onChange={(v) => setGive((s) => ({ ...s, [r]: v }))}
                />
                <Stepper
                  value={take[r] ?? 0}
                  max={partner !== null && hands[partner] ? hands[partner]![r] : 19}
                  label="get"
                  onChange={(v) => setTake((s) => ({ ...s, [r]: v }))}
                />
              </div>
            </div>
          ))}
        </div>
        {overlap && <p className="small trade-warn">a trade can't include the same resource on both sides</p>}
        <div className="overlay-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid || partner === null}
            onClick={() => onPropose(partner === -1 ? hands.map((_, i) => i).filter(i => i !== proposer) : partner!, give, take)}
          >
            Offer {countsLabel(give)} for {countsLabel(take)}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Year of Plenty picker: choose 2 resources from the bank (may be the same). */
function YearOfPlentyPanel({
  bank,
  onTake,
}: {
  bank: ResourceCounts
  onTake: (r1: Resource, r2: Resource) => void
}) {
  const [r1, setR1] = useState<Resource | null>(null)
  const [r2, setR2] = useState<Resource | null>(null)
  const ok = r1 && r2 && (r1 !== r2 ? bank[r1] >= 1 && bank[r2] >= 1 : bank[r1] >= 2)
  return (
    <div className="overlay">
      <div className="overlay-card">
        <h3>💰 Year of Plenty</h3>
        <p className="muted small">take any 2 resources from the bank (they may match)</p>
        {([1, 2] as const).map((n) => (
          <div key={n} className="trade-row">
            <span className="trade-label">take {n}</span>
            {RESOURCES.map((r) => {
              const picked = n === 1 ? r1 : r2
              const set = n === 1 ? setR1 : setR2
              const other = n === 1 ? r2 : r1
              // picking the same resource twice needs a stack of 2
              const disabled = bank[r] < (other === r ? 2 : 1)
              return (
                <button
                  key={r}
                  className={`trade-chip ${picked === r ? 'trade-chip-active' : ''}`}
                  disabled={disabled}
                  onClick={() => set(picked === r ? null : r)}
                >
                  {<ResourceIcon resource={r} />} <span className="trade-rate">{bank[r]}</span>
                </button>
              )
            })}
          </div>
        ))}
        <div className="overlay-actions">
          <button className="btn btn-primary" disabled={!ok} onClick={() => ok && onTake(r1!, r2!)}>
            Take {r1 ? RESOURCE_ICONS[r1] : '?'} + {r2 ? RESOURCE_ICONS[r2] : '?'}
          </button>
        </div>
      </div>
    </div>
  )
}

function GamePage() {
  const { match: matchParam, server: serverParam, players: playersParam, map: mapParam } = Route.useSearch()
  const [seed, setSeed] = useState(() => randomSeed())

  // multiplayer session (matchID + credentials in sessionStorage, PRD §7):
  // 'pending' = one render before we can touch sessionStorage (SSR-safe).
  const [mpSession, setMpSession] = useState<MpSession | null | 'pending'>(matchParam ? 'pending' : null)
  useEffect(() => {
    setMpSession(matchParam ? loadMpSession(matchParam) : null)
  }, [matchParam])

  const clientConfig = useMemo<ClientConfig | null>(() => {
    if (!matchParam) return { kind: 'hotseat', seed, numPlayers: playersParam ?? 4, mapPreset: mapParam ?? null }
    if (mpSession === 'pending' || !mpSession || mpSession.matchID !== matchParam) return null
    return {
      kind: 'mp',
      matchID: mpSession.matchID,
      seat: mpSession.playerID,
      credentials: mpSession.credentials,
      server: gameServerHost(),
      numPlayers: playersParam ?? 4,
    }
  }, [matchParam, mpSession, seed, serverParam, playersParam, mapParam])

  const { state, move } = useCatanClient(clientConfig)
  // multiplayer: the board seed comes from the server state, not the URL;
  // fixed-map rooms carry their preset inside G
  const board = useMemo(
    () => generateBoard(state?.G?.seed ?? (matchParam ? 0 : seed), state?.G?.mapPreset ?? mapParam ?? null),
    [state?.G?.seed, state?.G?.mapPreset, matchParam, seed, mapParam],
  )

  // local view state (animation gating, setup selection, history)
  const [kind, setKind] = useState<BuildKind>(null)
  const [showTableHands, setShowTableHands] = useState(false)
  const [actionTab, setActionTab] = useState<'build' | 'trade' | 'cards'>('build')
  const [dismissedCard, setDismissedCard] = useState(0)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [rolling, setRolling] = useState(false)
  const [history, setHistory] = useState<number[]>([])
  const [setupVertex, setSetupVertex] = useState<string | null>(null)
  const [bankGive, setBankGive] = useState<Resource | null>(null)
  const [bankTake, setBankTake] = useState<Resource | null>(null)
  const [showTradeOffer, setShowTradeOffer] = useState(false)
  const [counterSeat, setCounterSeat] = useState<number | null>(null)
  /** index of the monopoly card being played (picker open), else null */
  const [monoPick, setMonoPick] = useState<number | null>(null)
  const [rematching, setRematching] = useState(false)
  const navigate = useNavigate()

  const G = state?.G
  useEffect(() => { setCounterSeat(null) }, [G?.pendingTrade?.proposer, G?.pendingTrade?.partner])
  useEffect(() => {
    if (!G?.lastPlayedCard) return
    const sequence = G.lastPlayedCard.sequence
    const timer = window.setTimeout(() => setDismissedCard(sequence), 7000)
    return () => window.clearTimeout(timer)
  }, [G?.lastPlayedCard?.sequence])
  const ctx = state?.ctx
  const phase = ctx?.phase ?? 'setup'
  const current = Number(ctx?.currentPlayer ?? 0)
  // hotseat: everyone acts through one client. multiplayer: only your seat.
  const seat = clientConfig?.kind === 'mp' ? clientConfig.seat : null
  const actor = seat ?? current
  const myTurn = seat === null || seat === current
  /** other players' hands are masked by playerView in multiplayer */
  const hiddenHand = (i: number) => seat !== null && i !== seat
  const handSize = (i: number) => G?.handSizes?.[i] ?? totalCards(G?.hands[i] ?? { wood: 0, brick: 0, grain: 0, wool: 0, ore: 0 })
  const gameover = ctx?.gameover ?? null

  // placements from authoritative state → GameCanvas maps
  const placements = useMemo<PlacementState>(
    () => ({
      vertices: new Map(Object.entries(G?.buildings.vertices ?? {})),
      edges: new Map(Object.entries(G?.buildings.edges ?? {})),
    }),
    [G],
  )
  // roll animation follows every LIVE roll: any nonce that appears after the
  // first state sync animates for everyone at once. Only the state replayed on
  // connect/refresh (the first observed lastRoll) is adopted silently — the
  // dice never re-throw history when you (re)join mid-game.
  const rollSync = useRef<{ synced: boolean; nonce: number | null }>({ synced: false, nonce: null })
  const rollTrigger = useMemo<RollTrigger | null>(
    () => {
      const lr = G?.lastRoll
      const sync = rollSync.current
      if (!G) return null // no state yet — nothing synced
      if (!sync.synced) {
        rollSync.current = { synced: true, nonce: lr?.nonce ?? null }
        return null
      }
      if (!lr || lr.nonce === sync.nonce) return null
      return { ...lr }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [G?.lastRoll],
  )
  const productionReport = useMemo<ProductionReport | null>(
    () => (G?.lastProduction ? { gains: G.lastProduction.gains, tileIds: G.lastProduction.tileIds, nonce: G.lastProduction.nonce } : null),
    [G?.lastProduction],
  )

  // roll history follows engine rolls (opening rolls are marked seen but kept out)
  const lastNonce = useRef<number | null>(null)
  useEffect(() => {
    const lr = G?.lastRoll
    if (lr && lr.nonce !== lastNonce.current) {
      const isMain = ctx?.phase === 'main'
      lastNonce.current = lr.nonce
      if (isMain) setHistory((h) => [lr.sum, ...h].slice(0, 10))
    }
  }, [G?.lastRoll, ctx?.phase])

  // a triggered animation (own click or a remote roll) holds the UI in
  // "rolling…" until the dice settle — consistent for every viewer
  useEffect(() => {
    if (rollTrigger) setRolling(true)
  }, [rollTrigger])

  const onRollDone = useCallback(() => {
    if (G?.lastRoll) rollSync.current = { synced: true, nonce: G.lastRoll.nonce }
    setRolling(false)
  }, [G?.lastRoll])

  /** Creator-only rematch: same room code & seats, brand-new island. */
  const doRematch = async () => {
    if (!mpSession || mpSession === 'pending' || !mpSession.roomCode) return
    const token = loadCreatorToken(mpSession.roomCode)
    if (!token) return
    setRematching(true)
    try {
      const res = await fetch(`${roomsApiBase()}/rooms/${mpSession.roomCode}/rematch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorToken: token }),
      })
      if (!res.ok) throw new Error(String(res.status))
      // everyone re-takes their seat on the room page (credentials are re-issued)
      navigate({ to: '/online', search: { code: mpSession.roomCode } })
    } catch {
      setRematching(false)
    }
  }

  // multiplayer: publish the room alias as this seat's display name. bgio only
  // lets the active player move, so it lands on our first turn (opening roll).
  const aliasSynced = useRef(false)
  useEffect(() => {
    if (seat === null || !G || !myTurn || aliasSynced.current) return
    let alias = ''
    try {
      alias = (localStorage.getItem('catan-alias') ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
    } catch {
      alias = ''
    }
    aliasSynced.current = true
    if (alias && alias !== G.playerNames?.[seat]) move(seat, (m) => m.setPlayerName(alias))
  }, [G, seat, myTurn, move])

  // bank-trade selections reset whenever the turn moves on
  useEffect(() => {
    setBankGive(null)
    setBankTake(null)
  }, [current])

  const newGame = () => {
    setSeed(randomSeed())
    setKind(null)
    setRolling(false)
    setHistory([])
    setSetupVertex(null)
    setBankGive(null)
    setBankTake(null)
    setShowTradeOffer(false)
    setMonoPick(null)
    lastNonce.current = null
  }

  // -- interaction ---------------------------------------------------------------

  const onPick = useCallback(
    (target: PickTarget) => {
      if (!G || !ctx || !myTurn) return
      if (target.kind === 'tile') {
        if (G.robberStep === 'move') move(actor, (m) => m.moveRobber(target.id))
        return
      }
      if (phase === 'setup') {
        if (target.kind === 'vertex') {
          if (validSetupVertices(G).includes(target.id)) setSetupVertex(target.id)
        } else if (setupVertex && validSetupEdges(G, setupVertex).includes(target.id)) {
          move(actor, (m) => m.placeSetup(setupVertex, target.id))
          setSetupVertex(null)
        }
        return
      }
      // main phase: build as the active player (engine validates cost/legality)
      if (phase === 'main' && !G.robberStep) {
        if (target.kind === 'edge' && G.devStep === 'roadBuilding') {
          move(actor, (m) => m.placeFreeRoad(target.id))
          return
        }
        if (!G.rolled) return
        if (target.kind === 'vertex' && kind === 'settlement') move(actor, (m) => m.placeSettlement(target.id))
        if (target.kind === 'vertex' && kind === 'city') move(actor, (m) => m.upgradeCity(target.id))
        if (target.kind === 'edge' && kind === 'road') move(actor, (m) => m.placeRoad(target.id))
      }
    },
    [G, ctx, phase, actor, myTurn, setupVertex, kind, move],
  )

  const onHover = useCallback((info: HoverInfo | null) => setHover(info), [])

  const doRoll = () => {
    if (!G || phase !== 'main' || G.rolled || G.robberStep || G.devStep || G.pendingTrade || rolling || !myTurn) return
    setRolling(true)
    move(actor, (m) => m.roll())
  }

  // build mode shown to GameCanvas — ghosts are pre-filtered to legal spots
  const mode = useMemo<BuildMode>(() => {
    if (!myTurn) return { kind: null, player: actor }
    if (phase === 'setup' && G) {
      return setupVertex
        ? { kind: 'road', player: actor, allowedEdges: new Set(validSetupEdges(G, setupVertex)) }
        : { kind: 'settlement', player: actor, allowedVertices: new Set(validSetupVertices(G)) }
    }
    if (!G || phase !== 'main' || G.robberStep) return { kind: null, player: actor }
    // Road Building effect: ghosts for the free roads (no cost check)
    if (G.devStep === 'roadBuilding')
      return { kind: 'road', player: actor, allowedEdges: new Set(connectedRoadEdges(G, actor)) }
    if (!G.rolled) return { kind: null, player: actor }
    if (kind === 'road') return { kind, player: actor, allowedEdges: new Set(validRoadEdges(G, actor)) }
    if (kind === 'settlement')
      return { kind, player: actor, allowedVertices: new Set(validSettlementVertices(G, actor)) }
    if (kind === 'city') return { kind, player: actor, allowedVertices: new Set(validCityVertices(G, actor)) }
    return { kind: null, player: actor }
  }, [phase, setupVertex, actor, myTurn, kind, G])

  if (matchParam && mpSession === 'pending') return <div className="game-shell" />
  if (matchParam && !clientConfig)
    return (
      <div className="game-shell game-connecting">
        <div className="overlay">
          <div className="overlay-card">
            <h3>Session lost</h3>
            <p className="muted small">
              no seat credentials for this match in this browser — rejoin from the room page.
            </p>
            <div className="overlay-actions">
              <Link className="btn" to="/online" search={{}}>
                ⟵ Lobby
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  if (!G || !ctx) return <div className="game-shell" />

  const robberMode = G.robberStep === 'move'
  const canBuild = phase === 'main' && G.rolled && !rolling && !G.robberStep && !G.devStep && !G.pendingTrade && !gameover && myTurn
  const canTrade = canBuild && !G.pendingTrade
  const roadSpots = canBuild ? validRoadEdges(G, actor) : []
  const settlementSpots = canBuild ? validSettlementVertices(G, actor) : []
  const citySpots = canBuild ? validCityVertices(G, actor) : []
  const supply = pieceCounts(G, actor)
  const giveRate = bankGive ? bankTradeRate(G, actor, bankGive) : null
  const discardPid = G.robberStep === 'discard' ? Number(Object.keys(G.pendingDiscards)[0]) : null
  const diceResult: DiceRoll | null = G.lastRoll
  const vps = vpCounts(G)

  const turnBanner = gameover
    ? `${pname(G, gameover.winner)} wins${seat === gameover.winner ? ' — that’s you! 🎉' : '!'}`
    : phase === 'openingRoll'
      ? `${pname(G, current)} — roll for turn order`
      : phase === 'setup'
      ? `${pname(G, current)} · ${setupVertex ? 'Choose a connecting road' : 'Choose a settlement corner'}`
      : G.robberStep === 'discard'
        ? 'Robber! Players discard half their hand'
        : G.robberStep === 'move'
          ? `${pname(G, current)} — move the robber`
          : G.robberStep === 'steal'
            ? `${pname(G, current)} — choose a victim to rob`
            : G.pendingTrade
              ? `${pname(G, G.pendingTrade.partner)} — respond to ${pname(G, G.pendingTrade.proposer)}'s trade offer`
              : G.devStep === 'roadBuilding'
                ? `${pname(G, current)} — place free roads (${G.roadBuildingLeft} left)`
                : G.devStep === 'yearOfPlenty'
                  ? `${pname(G, current)} — choose 2 resources`
                  : !G.rolled
                    ? `${pname(G, current)} — roll the dice`
                    : `${pname(G, current)} — trade & build`

  const terrainCounts = TERRAIN_LEGEND
  const harborKinds = [...new Set(board.ports.map((p) => p.kind))].sort((a, b) =>
    a === 'generic' ? 1 : b === 'generic' ? -1 : RESOURCES.indexOf(a) - RESOURCES.indexOf(b),
  )

  return (
    <GameAudioProvider
          roll={G.lastRoll?.nonce ?? null}
          seven={G.lastRoll && isRobberRoll(G.lastRoll.sum) ? G.lastRoll.nonce : null}
          production={
            G.lastProduction
              ? `${G.lastProduction.nonce}|${RESOURCES.filter(r => G.lastProduction!.gains.some(g => g[r] > 0)).join(',')}`
              : null
          }
          buildings={Object.keys(G.buildings.edges).length + Object.values(G.buildings.vertices).length}
          cities={Object.values(G.buildings.vertices).filter((b) => b.type === 'city').length}
          robber={G.robberTileId}
          journal={G.log[0] ?? ''}
          winner={gameover?.winner ?? null}
          lost={gameover && seat !== null && seat !== gameover.winner ? gameover.winner : null}
          playedCard={G.lastPlayedCard ? `${G.lastPlayedCard.card}:${G.lastPlayedCard.sequence}` : undefined}
          seed={G.seed}
        >
    <div className="game-shell">
      <GameCanvas
        board={board}
        mode={mode}
        placements={placements}
        roll={rollTrigger}
        robberMode={robberMode}
        robberTileId={G.robberTileId}
        production={productionReport}
        onPick={onPick}
        onHover={onHover}
        onRollDone={onRollDone}
      />

      <header className="hud hud-top">
        <Link to="/" className="hud-brand">
          <img src="/assets/astra/ui/crest.svg" alt="" /> <span>CATAN</span>
        </Link>
        {seat !== null ? (
          <span className="hud-seat">
            <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[seat]) } as React.CSSProperties} />
            you are {pname(G, seat)}
            {mpSession && mpSession !== 'pending' && mpSession.roomCode ? ` · room ${mpSession.roomCode}` : ''}
          </span>
        ) : (
          <span className="hud-seed">{G.mapPreset ? mapPresetById(G.mapPreset)?.name ?? G.mapPreset : `island #${G.seed.toString(36)}`}</span>
        )}
        {seat === null && <button className="btn btn-small table-hands-toggle" onClick={() => setShowTableHands(true)}>Table hands</button>}
        <SoundToggle />
        {!matchParam && (
          <button className="btn btn-small" onClick={newGame}>
            ↻ New game
          </button>
        )}
        {matchParam && (
          <Link className="btn btn-small" to="/online" search={{}}>
            ⟵ Lobby
          </Link>
        )}
      </header>

      <div className={`turn-banner ${gameover ? 'turn-banner-win' : ''}`}>
        <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[current]) } as React.CSSProperties} />
        {turnBanner}
      </div>

      {showTableHands && seat === null && <dialog className="table-hands-dialog" aria-label="Local table hands" ref={node => { if (node && !node.open) node.showModal() }} onCancel={() => setShowTableHands(false)}><section className="overlay-card"><h2>Hands around the table</h2><p className="muted small">Local play · everyone’s cards are visible.</p>{G.hands.map((hand,i) => <div className="table-hand-summary" key={i}><strong>{pname(G,i)} · {handSize(i)} cards</strong><div>{RESOURCES.map(r=><span key={r}><ResourceIcon resource={r}/>{hand[r]}</span>)}</div></div>)}<button className="btn btn-primary" onClick={() => setShowTableHands(false)}>Back to the island</button></section></dialog>}
      <aside className="hud player-rail" aria-label="Player information">        <div className="rail-title"><span className="eyebrow">AROUND THE TABLE</span><small>10 points to win</small></div>
        <div className="hands">
          {G.hands.map((hand, i) => (
            <div key={i} className={`hand-row ${i === current ? 'hand-row-active' : ''}`}>
              <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[i]) } as React.CSSProperties} />
              <span className="hand-name">
                {pname(G, i)}
                {seat === i ? ' (you)' : ''}{i === current && <small className="player-turn-label">Playing</small>}
              </span>
              {hiddenHand(i) ? (
                <span className="hand-res muted">🂠 {handSize(i)} cards</span>
              ) : (
                <span className="hand-res">
                  {RESOURCES.map((r) => (
                    <span key={r} className={hand[r] > 0 ? '' : 'muted'}>
                      {<ResourceIcon resource={r} />}
                      {hand[r]}
                    </span>
                  ))}
                </span>
              )}
              <span className="hand-vp" title="victory points">
                {vps[i]} VP
              </span><span className="player-card-count">{handSize(i)} cards · {G.devHandSizes?.[i] ?? G.devHands[i].length} dev</span>
            </div>
          ))}
        </div>
{G.lastPlayedCard && <button className="last-card-note" onClick={() => setDismissedCard(0)}><span>LAST CARD PLAYED</span><strong>{DEV_CARD_INFO[G.lastPlayedCard.card].label}</strong><small>{pname(G,G.lastPlayedCard.player)}</small></button>}<Soundboard /></aside>
      <HandTray name={pname(G, actor)} hand={G.hands[actor]} cards={G.devHands[actor]} turn={ctx.turn}
        canPlay={phase === 'main' && myTurn && !gameover && !G.devStep && !G.robberStep && !G.pendingTrade && G.devPlayedAtTurn !== ctx.turn}
        onOpenCards={() => { setActionTab('cards'); setKind(null); requestAnimationFrame(() => document.getElementById('development-actions')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })) }}
      />
      {G.lastPlayedCard && dismissedCard !== G.lastPlayedCard.sequence && <section className="hud played-card-announcement" aria-live="polite"><span className="eyebrow">PLAYED FOR ALL TO SEE</span><button className="card-dismiss" aria-label="Dismiss played card" onClick={() => setDismissedCard(G.lastPlayedCard!.sequence)}>×</button><div className="played-card-symbol"><DevCardIcon card={G.lastPlayedCard.card} /></div><h2>{DEV_CARD_INFO[G.lastPlayedCard.card].label}</h2><p>{pname(G,G.lastPlayedCard.player)} played this card</p><small>{DEV_CARD_INFO[G.lastPlayedCard.card].hint}</small></section>}
      <aside className="hud hud-panel" aria-label="Turn controls"><div className="action-panel-body">
        <div className="table-heading"><span className="eyebrow">THE ISLAND</span><span>First to 10 points</span></div>
        <section className="captain-card"><div><span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[current]) } as React.CSSProperties} /><h2>{pname(G, current)}’s turn</h2><span className="captain-score">{vps[current]} <small>/ 10</small></span></div><p>{phase === 'setup' ? (setupVertex ? 'Connect your settlement with a road.' : 'Choose a glowing corner to settle.') : phase === 'openingRoll' ? 'Roll to decide who starts the adventure.' : G.devStep || G.robberStep || G.pendingTrade ? turnBanner : !myTurn ? `Waiting for ${pname(G,current)} to finish.` : !G.rolled ? 'Roll the dice to gather resources.' : 'Trade, build, then pass the dice.'}</p></section>
        {phase === 'setup' && <section className="setup-guide"><p className="eyebrow">YOUR FIRST FOOTHOLD</p><div className="setup-steps"><span className={!setupVertex ? 'current-step' : 'complete-step'}><b>{setupVertex ? '✓' : '1'}</b> Settle</span><i /><span className={setupVertex ? 'current-step' : ''}><b>2</b> Connect</span></div><p>{setupVertex ? 'Select a glowing road beside your new settlement.' : 'Corners touching different terrains give you more ways to gather resources.'}</p>{setupVertex && <button className="btn btn-small" onClick={() => setSetupVertex(null)}>↶ Choose another corner</button>}<small>Your second settlement collects starting resources.</small></section>}
        {phase === 'openingRoll' && (
          <>
            <h3>Opening roll</h3>
            <p className="muted small">everyone throws the dice — the highest total places first</p>
            <button
              className="btn btn-primary dice-roll-btn"
              disabled={!myTurn || G.openingRolls[current] !== null || rolling || !!gameover}
              onClick={() => {
                setRolling(true)
                move(actor, (m) => m.openingRoll())
              }}
            >
              {rolling ? 'Rolling…' : !myTurn ? `waiting for ${pname(G, current)}…` : '🎲 Roll for order'}
            </button>
            {diceResult && !rolling && (
              <div className="dice-result">
                <DieFace v={diceResult.die1} />
                <DieFace v={diceResult.die2} />
                <span className="dice-sum">{diceResult.sum}</span>
              </div>
            )}
            <ul className="legend opening-rolls">
              {G.openingRolls.map((r, i) => (
                <li key={i} className={r !== null && r === Math.max(...(G.openingRolls.filter((x): x is number => x !== null))) ? 'opening-best' : ''}>
                  <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[i]) } as React.CSSProperties} />
                  {pname(G, i)}
                  <span className="count">{r ?? '—'}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {phase === 'main' && (
          <>
            <h3>Dice</h3>
            {(!G.rolled || rolling || G.devStep || G.robberStep) && <button
              className="btn btn-primary dice-roll-btn"
              onClick={doRoll}
              disabled={G.rolled || !!G.robberStep || !!G.devStep || !!G.pendingTrade || rolling || !!gameover || !myTurn}
            >
              {rolling ? 'Rolling…' : G.devStep ? 'Finish your development card' : G.robberStep === 'move' ? 'Move the robber first' : '🎲 Roll dice'}
            </button>}
            {G.devStep === 'roadBuilding' && myTurn && <button className="btn end-turn-btn" onClick={() => move(actor, m => m.finishRoadBuilding())}>Finish Road Building</button>}
            {diceResult && !rolling && (
              <div className="dice-result">
                <DieFace v={diceResult.die1} />
                <DieFace v={diceResult.die2} />
                <span className={`dice-sum ${isRobberRoll(diceResult.sum) ? 'red' : ''}`}>{diceResult.sum}</span>
              </div>
            )}
            {G.robberStep === 'steal' && (
              <div className="steal-picker">
                <p className="small">Steal 1 random card from:</p>
                {G.stealTargets!.map((v) => (
                  <button key={v} className="chip" style={{ '--chip': hex(PLAYER_COLORS[v]) } as React.CSSProperties} onClick={() => move(actor, (m) => m.steal(v))}>
                    <span className="chip-dot" />
                    {pname(G, v)} ({handSize(v)} cards)
                  </button>
                ))}
              </div>
            )}
            {history.length > 0 && (
              <div className="roll-history" aria-label="recent rolls">
                {history.map((sum, i) => (
                  <span key={i} className={`roll-chip ${isRobberRoll(sum) ? 'seven' : ''}`}>
                    {sum}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        {phase === 'main' && <nav className="action-tabs" aria-label="Turn actions">{(['build','trade','cards'] as const).map(tab => <button key={tab} className={actionTab === tab ? 'selected' : ''} aria-pressed={actionTab === tab} onClick={() => {setActionTab(tab);setKind(null)}}>{tab === 'cards' ? 'Develop' : tab === 'build' ? 'Build' : 'Trade'}</button>)}</nav>}
        {phase === 'main' && actionTab === 'trade' && (
          <>
            <h3>Trade</h3>
            <div className="trade-row">
              <span className="trade-label">give</span>
              {RESOURCES.map((r) => {
                const rate = bankTradeRate(G, current, r)
                return (
                  <button
                    key={r}
                    className={`trade-chip ${bankGive === r ? 'trade-chip-active' : ''}`}
                    disabled={!canTrade || G.hands[actor][r] < rate}
                    title={`${rate} ${RESOURCE_LABELS[r]} → 1 of another resource${rate === 2 ? ' (2:1 port)' : rate === 3 ? ' (3:1 port)' : ''}`}
                    onClick={() => {
                      setBankGive(bankGive === r ? null : r)
                      if (bankTake === r) setBankTake(null)
                    }}
                  >
                    {<ResourceIcon resource={r} />}
                    <span className="trade-rate">{rate}:1</span>
                  </button>
                )
              })}
            </div>
            <div className="trade-row">
              <span className="trade-label">get</span>
              {RESOURCES.map((r) => (
                <button
                  key={r}
                  className={`trade-chip ${bankTake === r ? 'trade-chip-active' : ''}`}
                  disabled={!canTrade || G.bank[r] < 1 || r === bankGive}
                  onClick={() => setBankTake(bankTake === r ? null : r)}
                >
                  {<ResourceIcon resource={r} />}
                </button>
              ))}
            </div>
            <button
              className="btn bank-trade-btn"
              disabled={!canTrade || !bankGive || !bankTake}
              onClick={() => {
                if (!bankGive || !bankTake) return
                move(actor, (m) => m.tradeBank(bankGive, bankTake))
                setBankTake(null)
              }}
            >
              ⚖️ {bankGive && bankTake && giveRate ? `${giveRate}${RESOURCE_ICONS[bankGive]} → 1${RESOURCE_ICONS[bankTake]}` : 'bank trade'}
            </button>
            <button className="btn player-trade-btn" disabled={!canTrade} onClick={() => setShowTradeOffer(true)}>
              🤝 player trade…
            </button>
          </>
        )}

        {phase === 'main' && actionTab === 'build' && (
          <>
            <h3>Build</h3>
            <div className="build-row">
              <button
                className={`btn ${kind === 'road' ? 'btn-active' : ''}`}
                disabled={!canBuild || roadSpots.length === 0}
                onClick={() => setKind(kind === 'road' ? null : 'road')}
              >
                <span><GameIcon name="road" /> Road</span>
                <CostTag cost={BUILD_COSTS.road} hand={G.hands[actor]} />
              </button>
              <button
                className={`btn ${kind === 'settlement' ? 'btn-active' : ''}`}
                disabled={!canBuild || settlementSpots.length === 0}
                onClick={() => setKind(kind === 'settlement' ? null : 'settlement')}
              >
                <span><GameIcon name="settlement" /> Settlement</span>
                <CostTag cost={BUILD_COSTS.settlement} hand={G.hands[actor]} />
              </button>
              <button
                className={`btn ${kind === 'city' ? 'btn-active' : ''}`}
                disabled={!canBuild || citySpots.length === 0}
                onClick={() => setKind(kind === 'city' ? null : 'city')}
              >
                <span><GameIcon name="city" /> City</span>
                <CostTag cost={BUILD_COSTS.city} hand={G.hands[actor]} />
              </button>
              <button
                className="btn"
                disabled={!canBuild || !!G.devStep || G.devDeck.length === 0 || RESOURCES.some(r => G.hands[actor][r] < (DEV_COST[r] ?? 0))}
                title={G.devDeck.length === 0 ? 'the deck is empty' : 'draw from the development deck'}
                onClick={() => move(actor, (m) => m.buyDevCard())}
              >
                <span><GameIcon name="cards" /> Development</span>
                <CostTag cost={DEV_COST} hand={G.hands[actor]} />
              </button>
            </div>
            <p className="muted small supply-line">
              supply: 🛣 {SUPPLY_LIMITS.road - supply.road} · 🏠 {SUPPLY_LIMITS.settlement - supply.settlement} · 🏙{' '}
              {SUPPLY_LIMITS.city - supply.city} left
            </p>

            {G.lastBuild && G.lastBuild.player === actor && G.lastBuild.turn === ctx.turn && <button className="btn end-turn-btn" disabled={!canBuild} onClick={() => move(actor, m => m.undoBuild())}>↶ Undo last {G.lastBuild.kind}</button>}
            <p className="muted small">
              {canBuild
                ? 'Glowing spots are legal — costs are paid to the bank.'
                : !myTurn ? `Available on your turn.` : G.robberStep || G.devStep || G.pendingTrade ? 'Finish the current action to build.' : 'Roll the dice to unlock building.'}
            </p>
          </>
        )}

        {phase === 'main' && actionTab === 'cards' && (
          <>
            <h3 id="development-actions" tabIndex={-1}>Development cards</h3>
            <p className="muted small">
              deck {G.devDeck.length}/25 · 🏅{' '}
              {G.longestRoad
                ? `${pname(G, G.longestRoad.player)} ${G.longestRoad.size}`
                : '—'}{' '}
              · ⚔{' '}
              {G.largestArmy ? `${pname(G, G.largestArmy.player)} ${G.largestArmy.size}` : '—'}
            </p>
            {G.devHands[actor].length === 0 ? (
              <p className="muted small">no cards in hand</p>
            ) : (
              <div className="dev-hand">
                {G.devHands[actor].map((entry, i) => {
                  const info = DEV_CARD_INFO[entry.card]
                  const fresh = entry.boughtTurn === ctx.turn
                  const playable =
                    myTurn &&
                    !G.devStep &&
                    !G.robberStep &&
                    !G.pendingTrade &&
                    G.devPlayedAtTurn !== ctx.turn &&
                    !fresh &&
                    entry.card !== 'victoryPoint'
                  return (
                    <div key={i} className="dev-card-row" title={info.hint}>
                      <span className="dev-card-name">
                        <DevCardIcon card={entry.card} /> {info.label}
                        {fresh && <span className="muted small"> ·new</span>}
                      </span>
                      {entry.card === 'victoryPoint' ? (
                        <span className="muted small">+1 VP</span>
                      ) : entry.card === 'monopoly' ? (
                        <button className="btn btn-small" disabled={!playable} onClick={() => setMonoPick(i)}>
                          Play
                        </button>
                      ) : (
                        <button
                          className="btn btn-small"
                          disabled={!playable}
                          onClick={() => move(actor, (m) => m.playDevCard(i))}
                        >
                          Play
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <p className="muted small dev-knights">
              knights: {G.playedKnights.map((n, p) => `${pname(G, p)} ${n}`).join(' · ')}
            </p>
          </>
        )}


        <details className="hud-details"><summary>Bank supply</summary>        <p className="muted small bank-line">
          Bank:{' '}
          {RESOURCES.map((r) => (
            <span key={r}>
              {<ResourceIcon resource={r} />}
              {G.bank[r]}
            </span>
          ))}
        </p>

</details>
        <details className="hud-details"><summary>Voyage journal</summary>
        <ul className="log log-full">
          {G.log.map((line, i) => (
            <li key={i} className={i === 0 ? 'log-latest' : ''}>
              {line}
            </li>
          ))}
        </ul>

        </details><details className="hud-details"><summary>Island &amp; harbor guide</summary><h3>Island</h3>
        <ul className="legend">
          {terrainCounts.map(({ terrain, count }) => (
            <li key={terrain}>
              <span className="swatch" style={{ background: hex(TERRAIN_INFO[terrain].color) }} />
              {TERRAIN_INFO[terrain].label}
              <span className="count">×{count}</span>
            </li>
          ))}
        </ul>

        <h3>Harbors</h3>
        <ul className="legend">
          {harborKinds.map((kind) => (
            <li key={kind}>
              {kind === 'generic' ? (
                <span className="swatch" style={{ background: '#6e7f8f' }} />
              ) : (
                <ResourceIcon resource={kind} />
              )}
              {kind === 'generic'
                ? '3:1 · any resource'
                : `2:1 · ${RESOURCE_LABELS[kind]}`}
            </li>
          ))}
        </ul>

        </details>
        </div>
        {phase === 'main' && <div className="turn-footer"><button className="btn btn-primary turn-finish" disabled={!canBuild} onClick={() => move(actor, (m) => m.endTurn())}>End turn <span aria-hidden="true">→</span></button></div>}
      </aside>

      {hover && <div className="board-inspect" aria-live="polite">{hover.resourceLabel && <ResourceIcon resource={hover.resourceLabel} />}<div><strong>{hover.terrainLabel}{hover.number !== null ? ' · ' + hover.number : ''}</strong><small>{hover.portKind ? 'A settlement at either dock corner unlocks this trade.' : hover.resourceLabel ? 'Produces ' + RESOURCE_LABELS[hover.resourceLabel].toLowerCase() + ' when this number is rolled.' : 'The desert produces no resources.'}</small></div></div>}
      <footer className="hud hud-bottom">
        {phase === 'openingRoll'
          ? 'everyone rolls — highest total picks the first spot'
          : phase === 'setup'
            ? 'click a glowing corner → then a touching road slot'
            : 'drag · rotate | scroll · zoom | right-drag · pan'}
      </footer>

      {discardPid !== null &&
        !hiddenHand(discardPid) && (
          <DiscardPanel
            key={discardPid}
            player={discardPid}
            playerName={pname(G, discardPid)}
            hand={G.hands[discardPid]}
            required={G.pendingDiscards[discardPid]}
            onConfirm={(cards) => move(discardPid, (m) => m.discardHalf(cards))}
          />
        )}

      {G.pendingTrade && !showTradeOffer && counterSeat === null && (() => {
        const pt = G.pendingTrade!
        const responders = pt.partners ?? [pt.partner]
        const eligible = responders.filter(p => seat === null || seat === p)
        return (
          <div className="overlay"><div className="overlay-card">
            <h3>{responders.length > 1 ? 'An offer for the table' : 'Trade offer'}</h3>
            <p>{pname(G, pt.proposer)} offers {responders.map(p => pname(G, p)).join(', ')}</p>
            <p className="trade-terms">{countsLabel(pt.give)} <span className="trade-swap">⇄</span> {countsLabel(pt.take)}</p>
            {responders.length > 1 && <p className="muted small">The first acceptance completes the trade. A counter replaces this offer.</p>}
            {eligible.map(p => {
              // The offer is shown to every recipient even if they can't cover it —
              // refusing (or countering) must stay possible so nobody learns
              // that a player lacks a resource from the offer not arriving.
              const short = RESOURCES.some(r => pt.take[r] > G.hands[p][r])
              return (
                <section key={p}>
                  <p className="small">{pname(G, p)} receives {countsLabel(pt.give)} and gives {countsLabel(pt.take)}</p>
                  {short && <p className="small trade-warn">{pname(G, p)} doesn't hold enough cards for this offer — decline or counter</p>}
                  <div className="overlay-actions">
                    <button className="btn" onClick={() => move(p, m => m.declineTrade())}>Decline</button>
                    <button className="btn" onClick={() => setCounterSeat(p)}>Counter</button>
                    <button className="btn btn-primary" disabled={short} onClick={() => move(p, m => m.acceptTrade())}>Accept</button>
                  </div>
                </section>
              )
            })}
            {!eligible.length && <p className="muted small">Waiting for a response…</p>}
          </div></div>
        )
      })()}
      {counterSeat !== null && G.pendingTrade && <TradeOfferPanel
        key={counterSeat}
        proposer={counterSeat}
        target={G.pendingTrade.proposer}
        initialGive={G.pendingTrade.take}
        initialTake={G.pendingTrade.give}
        names={G.hands.map((_, i) => pname(G, i))}
        hands={G.hands.map((h, i) => hiddenHand(i) ? null : h)}
        onPropose={(_partner, give, take) => { move(counterSeat, m => m.counterTrade(give, take)); setCounterSeat(null) }}
        onClose={() => setCounterSeat(null)}
      />}

      {showTradeOffer && canTrade && (
        <TradeOfferPanel
          proposer={actor}
          names={G.hands.map((_, i) => pname(G, i))}
          hands={G.hands.map((h, i) => (hiddenHand(i) ? null : h))}
          onPropose={(partner, give, take) => {
            move(actor, (m) => m.proposeTrade(partner, give, take))
            setShowTradeOffer(false)
          }}
          onClose={() => setShowTradeOffer(false)}
        />
      )}

      {monoPick !== null && !G.devStep && (
        <div className="overlay">
          <div className="overlay-card">
            <h3>👑 Monopoly — name a resource</h3>
            <p className="muted small">every other player hands over all their cards of it</p>
            <div className="trade-partners">
              {RESOURCES.map((r) => (
                <button
                  key={r}
                  className="trade-chip"
                  onClick={() => {
                    move(actor, (m) => m.playDevCard(monoPick, r))
                    setMonoPick(null)
                  }}
                >
                  {<ResourceIcon resource={r} />} {RESOURCE_LABELS[r]}
                </button>
              ))}
            </div>
            <div className="overlay-actions">
              <button className="btn" onClick={() => setMonoPick(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {G.devStep === 'yearOfPlenty' && !G.robberStep && (
        <YearOfPlentyPanel
          bank={G.bank}
          onTake={(r1, r2) => move(actor, (m) => m.takeYearOfPlenty(r1, r2))}
        />
      )}

      {gameover && (
        <div className="overlay">
          <div className="overlay-card overlay-win">
            <h2>
              <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[gameover.winner]) } as React.CSSProperties} />{' '}
              {pname(G, gameover.winner)} wins with {vps[gameover.winner]} VP!
            </h2>
            {matchParam ? (
              <>
                {mpSession && mpSession !== 'pending' && loadCreatorToken(mpSession.roomCode ?? '') !== null && (
                  <button className="btn btn-primary" disabled={rematching} onClick={() => void doRematch()}>
                    {rematching ? 'Setting up…' : '🔁 Rematch — fresh island'}
                  </button>
                )}
                <Link className="btn" to="/online" search={{}}>
                  Back to the lobby
                </Link>
              </>
            ) : (
              <button className="btn btn-primary" onClick={newGame}>
                Play again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
    </GameAudioProvider>
  )
}

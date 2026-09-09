import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Client } from 'boardgame.io/client'
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
import { randomSeed } from '#/game/rng'
import { isRobberRoll, type DiceRoll } from '#/game/dice'
import {
  BUILD_COSTS,
  SUPPLY_LIMITS,
  bankTradeRate,
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

export const Route = createFileRoute('/game')({ component: GamePage })

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')

/** Pip grid for the HUD dice (col, row in a 3×3 layout). */
const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
}

/** Static island legend — module-level so no hook ordering can break. */
const TERRAIN_LEGEND = TERRAIN_COUNTS.map(([terrain, count]) => ({ terrain, count }))

function DieFace({ v }: { v: number }) {
  return (
    <span className="die-face" role="img" aria-label={`die showing ${v}`}>
      {PIPS[v].map(([c, r], i) => (
        <i key={i} style={{ left: `${15 + c * 35}%`, top: `${15 + r * 35}%` }} />
      ))}
    </span>
  )
}

type BgioClient = ReturnType<typeof Client>

/** Owns one local boardgame.io client per seed — the whole game's brain. */
function useCatanClient(seed: number) {
  const [state, setState] = useState<BgioState | null>(null)
  const clientRef = useRef<BgioClient | null>(null)

  useEffect(() => {
    const client: BgioClient = Client({ game: createCatanGame(seed), numPlayers: PLAYER_COUNT })
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
  }, [seed])

  /** Dispatch a move as the given player (hotseat: we act for everyone). */
  const move = useCallback(
    (pid: number, fn: (moves: Record<string, (...args: unknown[]) => unknown>) => void) => {
      const client = clientRef.current
      if (!client) return
      client.updatePlayerID(String(pid))
      fn(client.moves as Record<string, (...args: unknown[]) => unknown>)
    },
    [],
  )

  return { state, move }
}

/** Discard-half overlay: pick exactly `required` cards. */
function DiscardPanel({
  player,
  hand,
  required,
  onConfirm,
}: {
  player: number
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
          {PLAYER_NAMES[player]} — discard {required} card{required === 1 ? '' : 's'}
        </h3>
        <div className="discard-grid">
          {RESOURCES.map((r) => (
            <div key={r} className="discard-cell">
              <span className="discard-label">
                {RESOURCE_ICONS[r]} {RESOURCE_LABELS[r]} ×{hand[r]}
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
          {RESOURCE_ICONS[r]}
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
  hands,
  onPropose,
  onClose,
}: {
  proposer: number
  hands: ResourceCounts[]
  onPropose: (partner: number, give: Partial<ResourceCounts>, take: Partial<ResourceCounts>) => void
  onClose: () => void
}) {
  const [partner, setPartner] = useState<number | null>(null)
  const [give, setGive] = useState<Partial<ResourceCounts>>({})
  const [take, setTake] = useState<Partial<ResourceCounts>>({})
  const giveTotal = RESOURCES.reduce((n, r) => n + (give[r] ?? 0), 0)
  const takeTotal = RESOURCES.reduce((n, r) => n + (take[r] ?? 0), 0)
  const overlap = RESOURCES.some((r) => (give[r] ?? 0) > 0 && (take[r] ?? 0) > 0)
  const valid = partner !== null && giveTotal >= 1 && takeTotal >= 1 && !overlap

  return (
    <div className="overlay">
      <div className="overlay-card">
        <h3>
          <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[proposer]) } as React.CSSProperties} />{' '}
          {PLAYER_NAMES[proposer]} — propose a trade
        </h3>
        <div className="trade-partners">
          {hands.map((_, p) =>
            p !== proposer ? (
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
                {PLAYER_NAMES[p]}
              </button>
            ) : null,
          )}
        </div>
        <div className="trade-grid">
          {RESOURCES.map((r) => (
            <div key={r} className="discard-cell">
              <span className="discard-label">
                {RESOURCE_ICONS[r]} {RESOURCE_LABELS[r]}
                <span className="muted small">
                  {' '}
                  you {hands[proposer][r]} · them {partner !== null ? hands[partner][r] : '—'}
                </span>
              </span>
              <div className="trade-steppers">
                <Stepper
                  value={give[r] ?? 0}
                  max={hands[proposer][r]}
                  label="give"
                  onChange={(v) => setGive((s) => ({ ...s, [r]: v }))}
                />
                <Stepper
                  value={take[r] ?? 0}
                  max={partner !== null ? hands[partner][r] : 0}
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
            onClick={() => onPropose(partner!, give, take)}
          >
            Offer {countsLabel(give)} for {countsLabel(take)}
          </button>
        </div>
      </div>
    </div>
  )
}

function GamePage() {
  const [seed, setSeed] = useState(() => randomSeed())
  const { state, move } = useCatanClient(seed)
  const board = useMemo(() => generateBoard(seed), [seed])

  // local view state (animation gating, setup selection, history)
  const [kind, setKind] = useState<BuildKind>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [rolling, setRolling] = useState(false)
  const [history, setHistory] = useState<number[]>([])
  const [setupVertex, setSetupVertex] = useState<string | null>(null)
  const [bankGive, setBankGive] = useState<Resource | null>(null)
  const [bankTake, setBankTake] = useState<Resource | null>(null)
  const [showTradeOffer, setShowTradeOffer] = useState(false)

  const G = state?.G
  const ctx = state?.ctx
  const phase = ctx?.phase ?? 'setup'
  const current = Number(ctx?.currentPlayer ?? 0)
  const gameover = ctx?.gameover ?? null

  // placements from authoritative state → GameCanvas maps
  const placements = useMemo<PlacementState>(
    () => ({
      vertices: new Map(Object.entries(G?.buildings.vertices ?? {})),
      edges: new Map(Object.entries(G?.buildings.edges ?? {})),
    }),
    [G],
  )
  const rollTrigger = useMemo<RollTrigger | null>(
    () => (G?.lastRoll ? { ...G.lastRoll } : null),
    [G?.lastRoll],
  )
  const productionReport = useMemo<ProductionReport | null>(
    () => (G?.lastProduction ? { gains: G.lastProduction.gains, tileIds: G.lastProduction.tileIds, nonce: G.lastProduction.nonce } : null),
    [G?.lastProduction],
  )

  // roll history follows engine rolls
  const lastNonce = useRef<number | null>(null)
  useEffect(() => {
    const lr = G?.lastRoll
    if (lr && lr.nonce !== lastNonce.current) {
      lastNonce.current = lr.nonce
      setHistory((h) => [lr.sum, ...h].slice(0, 10))
    }
  }, [G?.lastRoll])

  const onRollDone = useCallback(() => setRolling(false), [])

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
    lastNonce.current = null
  }

  // -- interaction ---------------------------------------------------------------

  const onPick = useCallback(
    (target: PickTarget) => {
      if (!G || !ctx) return
      if (target.kind === 'tile') {
        if (G.robberStep === 'move') move(current, (m) => m.moveRobber(target.id))
        return
      }
      if (phase === 'setup') {
        if (target.kind === 'vertex') {
          if (validSetupVertices(G).includes(target.id)) setSetupVertex(target.id)
        } else if (setupVertex && validSetupEdges(G, setupVertex).includes(target.id)) {
          move(current, (m) => m.placeSetup(setupVertex, target.id))
          setSetupVertex(null)
        }
        return
      }
      // main phase: build as the active player (engine validates cost/legality)
      if (phase === 'main' && G.rolled && !G.robberStep) {
        if (target.kind === 'vertex' && kind === 'settlement') move(current, (m) => m.placeSettlement(target.id))
        if (target.kind === 'vertex' && kind === 'city') move(current, (m) => m.upgradeCity(target.id))
        if (target.kind === 'edge' && kind === 'road') move(current, (m) => m.placeRoad(target.id))
      }
    },
    [G, ctx, phase, current, setupVertex, kind, move],
  )

  const onHover = useCallback((info: HoverInfo | null) => setHover(info), [])

  const doRoll = () => {
    if (!G || phase !== 'main' || G.rolled || G.robberStep || rolling) return
    setRolling(true)
    move(current, (m) => m.roll())
  }

  // build mode shown to GameCanvas — ghosts are pre-filtered to legal spots
  const mode = useMemo<BuildMode>(() => {
    if (phase === 'setup' && G) {
      return setupVertex
        ? { kind: 'road', player: current, allowedEdges: new Set(validSetupEdges(G, setupVertex)) }
        : { kind: 'settlement', player: current, allowedVertices: new Set(validSetupVertices(G)) }
    }
    if (!G || phase !== 'main' || !G.rolled || G.robberStep) return { kind: null, player: current }
    if (kind === 'road') return { kind, player: current, allowedEdges: new Set(validRoadEdges(G, current)) }
    if (kind === 'settlement')
      return { kind, player: current, allowedVertices: new Set(validSettlementVertices(G, current)) }
    if (kind === 'city') return { kind, player: current, allowedVertices: new Set(validCityVertices(G, current)) }
    return { kind: null, player: current }
  }, [phase, setupVertex, current, kind, G])

  if (!G || !ctx) return <div className="game-shell" />

  const robberMode = G.robberStep === 'move'
  const canBuild = phase === 'main' && G.rolled && !G.robberStep
  const canTrade = canBuild && !G.pendingTrade
  const roadSpots = canBuild ? validRoadEdges(G, current) : []
  const settlementSpots = canBuild ? validSettlementVertices(G, current) : []
  const citySpots = canBuild ? validCityVertices(G, current) : []
  const supply = pieceCounts(G, current)
  const giveRate = bankGive ? bankTradeRate(G, current, bankGive) : null
  const discardPid = G.robberStep === 'discard' ? Number(Object.keys(G.pendingDiscards)[0]) : null
  const diceResult: DiceRoll | null = G.lastRoll
  const vps = vpCounts(G)

  const turnBanner = gameover
    ? `${PLAYER_NAMES[gameover.winner]} wins!`
    : phase === 'setup'
      ? `${PLAYER_NAMES[current]} — place settlement${setupVertex ? ' ✓' : ''} + road${setupVertex ? '' : ' (settlement first)'}`
      : G.robberStep === 'discard'
        ? 'Robber! Players discard half their hand'
        : G.robberStep === 'move'
          ? `${PLAYER_NAMES[current]} — move the robber`
          : G.robberStep === 'steal'
            ? `${PLAYER_NAMES[current]} — choose a victim to rob`
            : G.pendingTrade
              ? `${PLAYER_NAMES[G.pendingTrade.partner]} — respond to ${PLAYER_NAMES[G.pendingTrade.proposer]}'s trade offer`
              : !G.rolled
                ? `${PLAYER_NAMES[current]} — roll the dice`
                : `${PLAYER_NAMES[current]} — trade & build`

  const terrainCounts = TERRAIN_LEGEND

  return (
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
          ⟵ <span>Catan 3D</span>
        </Link>
        <span className="hud-seed">island #{seed.toString(36)}</span>
        <button className="btn btn-small" onClick={newGame}>
          ↻ New game
        </button>
      </header>

      <div className={`turn-banner ${gameover ? 'turn-banner-win' : ''}`}>
        <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[current]) } as React.CSSProperties} />
        {turnBanner}
      </div>

      <aside className="hud hud-panel">
        {phase === 'main' && (
          <>
            <h3>Dice</h3>
            <button
              className="btn btn-primary dice-roll-btn"
              onClick={doRoll}
              disabled={G.rolled || !!G.robberStep || rolling || !!gameover}
            >
              {rolling ? 'Rolling…' : G.robberStep === 'move' ? 'Move the robber first' : '🎲 Roll dice'}
            </button>
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
                  <button key={v} className="chip" style={{ '--chip': hex(PLAYER_COLORS[v]) } as React.CSSProperties} onClick={() => move(current, (m) => m.steal(v))}>
                    <span className="chip-dot" />
                    {PLAYER_NAMES[v]} ({totalCards(G.hands[v])} cards)
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

        <h3>Hands</h3>
        <div className="hands">
          {G.hands.map((hand, i) => (
            <div key={i} className={`hand-row ${i === current && phase !== 'setup' ? 'hand-row-active' : ''}`}>
              <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[i]) } as React.CSSProperties} />
              <span className="hand-name">{PLAYER_NAMES[i]}</span>
              <span className="hand-res">
                {RESOURCES.map((r) => (
                  <span key={r} className={hand[r] > 0 ? '' : 'muted'}>
                    {RESOURCE_ICONS[r]}
                    {hand[r]}
                  </span>
                ))}
              </span>
              <span className="hand-vp" title="victory points">
                {vps[i]} VP
              </span>
            </div>
          ))}
        </div>
        <p className="muted small bank-line">
          Bank:{' '}
          {RESOURCES.map((r) => (
            <span key={r}>
              {RESOURCE_ICONS[r]}
              {G.bank[r]}
            </span>
          ))}
        </p>

        {phase === 'main' && (
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
                    disabled={!canTrade || G.hands[current][r] < rate}
                    title={`${rate} ${RESOURCE_LABELS[r]} → 1 of another resource${rate === 2 ? ' (2:1 port)' : rate === 3 ? ' (3:1 port)' : ''}`}
                    onClick={() => {
                      setBankGive(bankGive === r ? null : r)
                      if (bankTake === r) setBankTake(null)
                    }}
                  >
                    {RESOURCE_ICONS[r]}
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
                  {RESOURCE_ICONS[r]}
                </button>
              ))}
            </div>
            <button
              className="btn bank-trade-btn"
              disabled={!canTrade || !bankGive || !bankTake}
              onClick={() => {
                if (!bankGive || !bankTake) return
                move(current, (m) => m.tradeBank(bankGive, bankTake))
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

        {phase === 'main' && (
          <>
            <h3>Build</h3>
            <div className="build-row">
              <button
                className={`btn ${kind === 'road' ? 'btn-active' : ''}`}
                disabled={!canBuild || roadSpots.length === 0}
                onClick={() => setKind(kind === 'road' ? null : 'road')}
              >
                <span>🛣 Road</span>
                <CostTag cost={BUILD_COSTS.road} hand={G.hands[current]} />
              </button>
              <button
                className={`btn ${kind === 'settlement' ? 'btn-active' : ''}`}
                disabled={!canBuild || settlementSpots.length === 0}
                onClick={() => setKind(kind === 'settlement' ? null : 'settlement')}
              >
                <span>🏠 Settlement</span>
                <CostTag cost={BUILD_COSTS.settlement} hand={G.hands[current]} />
              </button>
              <button
                className={`btn ${kind === 'city' ? 'btn-active' : ''}`}
                disabled={!canBuild || citySpots.length === 0}
                onClick={() => setKind(kind === 'city' ? null : 'city')}
              >
                <span>🏙 City</span>
                <CostTag cost={BUILD_COSTS.city} hand={G.hands[current]} />
              </button>
            </div>
            <p className="muted small supply-line">
              supply: 🛣 {SUPPLY_LIMITS.road - supply.road} · 🏠 {SUPPLY_LIMITS.settlement - supply.settlement} · 🏙{' '}
              {SUPPLY_LIMITS.city - supply.city} left
            </p>
            <button className="btn end-turn-btn" disabled={!canBuild} onClick={() => move(current, (m) => m.endTurn())}>
              End turn ⟶
            </button>
            <p className="muted small">
              {canBuild
                ? 'Glowing spots are legal — costs are paid to the bank.'
                : 'Roll the dice first; build afterwards.'}
            </p>
          </>
        )}

        <h3>Log</h3>
        <ul className="log">
          {G.log.slice(0, 7).map((line, i) => (
            <li key={i} className={i === 0 ? 'log-latest' : ''}>
              {line}
            </li>
          ))}
        </ul>

        <h3>Island</h3>
        <ul className="legend">
          {terrainCounts.map(({ terrain, count }) => (
            <li key={terrain}>
              <span className="swatch" style={{ background: hex(TERRAIN_INFO[terrain].color) }} />
              {TERRAIN_INFO[terrain].label}
              <span className="count">×{count}</span>
            </li>
          ))}
        </ul>

        {hover && (
          <>
            <h3>Hovering</h3>
            <p className="small">
              <strong>{hover.terrainLabel}</strong>
              <br />
              {hover.resourceLabel ? <>produces {RESOURCE_LABELS[hover.resourceLabel]}</> : 'produces nothing'}
              {hover.number !== null && (
                <>
                  <br />
                  number token: <strong className={hover.number === 6 || hover.number === 8 ? 'red' : ''}>{hover.number}</strong>
                </>
              )}
            </p>
          </>
        )}
      </aside>

      <footer className="hud hud-bottom">
        {phase === 'setup' ? 'click a glowing corner → then a touching road slot' : 'drag · rotate | scroll · zoom | right-drag · pan'}
      </footer>

      {discardPid !== null && (
        <DiscardPanel
          key={discardPid}
          player={discardPid}
          hand={G.hands[discardPid]}
          required={G.pendingDiscards[discardPid]}
          onConfirm={(cards) => move(discardPid, (m) => m.discardHalf(cards))}
        />
      )}

      {G.pendingTrade && !showTradeOffer && (() => {
        const pt = G.pendingTrade!
        return (
          <div className="overlay">
            <div className="overlay-card">
              <h3>Trade offer</h3>
              <p className="trade-parties">
                <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[pt.proposer]) } as React.CSSProperties} />{' '}
                {PLAYER_NAMES[pt.proposer]} offers{' '}
                <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[pt.partner]) } as React.CSSProperties} />{' '}
                {PLAYER_NAMES[pt.partner]}
              </p>
              <p className="trade-terms">
                {countsLabel(pt.give)} <span className="trade-swap">⇄</span> {countsLabel(pt.take)}
              </p>
              <div className="overlay-actions">
                <button className="btn" onClick={() => move(pt.partner, (m) => m.declineTrade())}>
                  Decline
                </button>
                <button className="btn btn-primary" onClick={() => move(pt.partner, (m) => m.acceptTrade())}>
                  Accept
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {showTradeOffer && canTrade && (
        <TradeOfferPanel
          proposer={current}
          hands={G.hands}
          onPropose={(partner, give, take) => {
            move(current, (m) => m.proposeTrade(partner, give, take))
            setShowTradeOffer(false)
          }}
          onClose={() => setShowTradeOffer(false)}
        />
      )}

      {gameover && (
        <div className="overlay">
          <div className="overlay-card overlay-win">
            <h2>
              <span className="chip-dot" style={{ '--chip': hex(PLAYER_COLORS[gameover.winner]) } as React.CSSProperties} />{' '}
              {PLAYER_NAMES[gameover.winner]} wins with {vps[gameover.winner]} VP!
            </h2>
            <button className="btn btn-primary" onClick={newGame}>
              Play again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { GameCanvas, type RollTrigger } from '#/components/GameCanvas'
import {
  PLAYER_COLORS,
  PLAYER_COUNT,
  PLAYER_NAMES,
  type BuildKind,
  type HoverInfo,
  type PickTarget,
  type PlacementState,
} from '#/three/GameView'
import { generateBoard } from '#/game/board'
import { randomSeed } from '#/game/rng'
import { isRobberRoll, rollDice, type DiceRoll } from '#/game/dice'
import { RESOURCE_LABELS, TERRAIN_INFO, TERRAIN_COUNTS } from '#/game/terrain'

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

function DieFace({ v }: { v: number }) {
  return (
    <span className="die-face" role="img" aria-label={`die showing ${v}`}>
      {PIPS[v].map(([c, r], i) => (
        <i key={i} style={{ left: `${15 + c * 35}%`, top: `${15 + r * 35}%` }} />
      ))}
    </span>
  )
}

function GamePage() {
  const [seed, setSeed] = useState(() => randomSeed())
  const board = useMemo(() => generateBoard(seed), [seed])

  const [player, setPlayer] = useState(0)
  const [kind, setKind] = useState<BuildKind>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [placements, setPlacements] = useState<PlacementState>(() => ({
    vertices: new Map(),
    edges: new Map(),
  }))

  // dice + robber state
  const [roll, setRoll] = useState<RollTrigger | null>(null)
  const [rolling, setRolling] = useState(false)
  const [diceResult, setDiceResult] = useState<DiceRoll | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [robberTileId, setRobberTileId] = useState(board.desertTileId)
  const [robberPending, setRobberPending] = useState(false)
  const [robberNote, setRobberNote] = useState<string | null>(null)
  const rollRef = useRef<RollTrigger | null>(null)
  rollRef.current = roll

  // new island → robber returns to its desert
  useEffect(() => {
    setRobberTileId(board.desertTileId)
  }, [board])

  const newBoard = () => {
    setSeed(randomSeed())
    setPlacements({ vertices: new Map(), edges: new Map() })
    setKind(null)
    setRoll(null)
    setRolling(false)
    setDiceResult(null)
    setHistory([])
    setRobberPending(false)
    setRobberNote(null)
  }

  const onPick = useCallback(
    (target: PickTarget) => {
      if (target.kind === 'tile') {
        // robber destination click (M6: move only — steal/discard flow lands in M8)
        setRobberTileId(target.id)
        setRobberPending(false)
        setRobberNote('Robber moved — discard-half & steal flow lands in M8.')
        return
      }
      setPlacements((prev) => {
        const vertices = new Map(prev.vertices)
        const edges = new Map(prev.edges)
        if (target.kind === 'vertex') {
          if (vertices.has(target.id)) vertices.delete(target.id) // click again to remove (sandbox)
          else vertices.set(target.id, { player, type: 'settlement' })
        } else {
          if (edges.has(target.id)) edges.delete(target.id)
          else edges.set(target.id, { player })
        }
        return { vertices, edges }
      })
    },
    [player],
  )

  const doRoll = useCallback(() => {
    if (rolling || robberPending) return
    const result = rollDice()
    setRoll({ ...result, nonce: (rollRef.current?.nonce ?? 0) + 1 })
    setRolling(true)
    setRobberNote(null)
  }, [rolling, robberPending])

  const onRollDone = useCallback(() => {
    setRolling(false)
    const r = rollRef.current
    if (!r) return
    setDiceResult(r)
    setHistory((h) => [r.sum, ...h].slice(0, 10))
    if (isRobberRoll(r.sum)) {
      setRobberPending(true)
      setKind(null)
      setRobberNote('A 7! Click any hex to move the robber.')
    }
  }, [])

  const onHover = useCallback((info: HoverInfo | null) => setHover(info), [])
  const mode = useMemo(() => ({ kind, player }), [kind, player])
  const terrainCounts = useMemo(
    () =>
      TERRAIN_COUNTS.map(([terrain, count]) => ({ terrain, count })),
    [],
  )

  return (
    <div className="game-shell">
      <GameCanvas
        board={board}
        mode={mode}
        placements={placements}
        roll={roll}
        robberMode={robberPending}
        robberTileId={robberTileId}
        onPick={onPick}
        onHover={onHover}
        onRollDone={onRollDone}
      />

      <header className="hud hud-top">
        <Link to="/" className="hud-brand">
          ⟵ <span>Catan 3D</span>
        </Link>
        <span className="hud-seed">island #{seed.toString(36)}</span>
        <button className="btn btn-small" onClick={newBoard}>
          ↻ New island
        </button>
      </header>

      <aside className="hud hud-panel">
        <h3>Builder</h3>
        <div className="player-row">
          {Array.from({ length: PLAYER_COUNT }, (_, i) => (
            <button
              key={i}
              className={`chip ${i === player ? 'chip-active' : ''}`}
              style={{ '--chip': hex(PLAYER_COLORS[i]) } as React.CSSProperties}
              onClick={() => setPlayer(i)}
              title={PLAYER_NAMES[i]}
            >
              <span className="chip-dot" />
              {PLAYER_NAMES[i]}
            </button>
          ))}
        </div>

        <div className="build-row">
          <button className={`btn ${kind === 'road' ? 'btn-active' : ''}`} onClick={() => setKind(kind === 'road' ? null : 'road')}>
            🛣 Road
          </button>
          <button
            className={`btn ${kind === 'settlement' ? 'btn-active' : ''}`}
            onClick={() => setKind(kind === 'settlement' ? null : 'settlement')}
          >
            🏠 Settlement
          </button>
        </div>
        <p className="muted small">
          {kind
            ? `Click a highlighted ${kind === 'road' ? 'edge' : 'corner'} to place — click a piece again to remove it.`
            : 'Pick a piece type, then click the board. Rules enforcement lands in M9.'}
        </p>

        <h3>Dice</h3>
        <button className="btn btn-primary dice-roll-btn" onClick={doRoll} disabled={rolling || robberPending}>
          {rolling ? 'Rolling…' : robberPending ? 'Move the robber first' : '🎲 Roll dice'}
        </button>
        {diceResult && !rolling && (
          <div className="dice-result">
            <DieFace v={diceResult.die1} />
            <DieFace v={diceResult.die2} />
            <span className={`dice-sum ${isRobberRoll(diceResult.sum) ? 'red' : ''}`}>{diceResult.sum}</span>
          </div>
        )}
        {robberNote && <p className={`robber-note ${robberPending ? 'robber-note-active' : ''}`}>🥷 {robberNote}</p>}
        {history.length > 0 && (
          <div className="roll-history" aria-label="recent rolls">
            {history.map((sum, i) => (
              <span key={i} className={`roll-chip ${isRobberRoll(sum) ? 'seven' : ''}`}>
                {sum}
              </span>
            ))}
          </div>
        )}

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

        <h3>Placed</h3>
        <p className="muted small">
          {[...placements.vertices.values()].length} settlements · {[...placements.edges.values()].length} roads
        </p>

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

      <footer className="hud hud-bottom">drag · rotate &nbsp;|&nbsp; scroll · zoom &nbsp;|&nbsp; right-drag · pan</footer>
    </div>
  )
}

import { useCallback, useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { GameCanvas } from '#/components/GameCanvas'
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
import { RESOURCE_LABELS, TERRAIN_INFO, TERRAIN_COUNTS } from '#/game/terrain'

export const Route = createFileRoute('/game')({ component: GamePage })

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')

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

  const newBoard = () => {
    setSeed(randomSeed())
    setPlacements({ vertices: new Map(), edges: new Map() })
    setKind(null)
  }

  const onPick = useCallback(
    (target: PickTarget) => {
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

  const onHover = useCallback((info: HoverInfo | null) => setHover(info), [])
  const mode = useMemo(() => ({ kind, player }), [kind, player])

  const terrainCounts = useMemo(
    () =>
      TERRAIN_COUNTS.map(([terrain, count]) => ({ terrain, count })),
    [],
  )

  return (
    <div className="game-shell">
      <GameCanvas board={board} mode={mode} placements={placements} onPick={onPick} onHover={onHover} />

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

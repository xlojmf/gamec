import { useEffect, useRef } from 'react'
import {
  GameView,
  type BuildMode,
  type HoverInfo,
  type PickTarget,
  type PlacementState,
} from '../three/GameView'
import type { Board } from '../game/board'
import type { DiceRoll } from '../game/dice'
import type { ResourceCounts } from '../game/terrain'

export interface RollTrigger extends DiceRoll {
  /** Bumped every throw so repeated identical results still re-trigger. */
  nonce: number
}

export interface ProductionReport {
  gains: ResourceCounts[]
  tileIds: string[]
  nonce: number
}

interface GameCanvasProps {
  board: Board
  mode: BuildMode
  placements: PlacementState
  roll: RollTrigger | null
  robberMode: boolean
  robberTileId: string
  production: ProductionReport | null
  onPick: (target: PickTarget) => void
  onHover: (info: HoverInfo | null) => void
  onRollDone: () => void
}

/**
 * React ↔ Three.js bridge. Owns exactly one GameView instance per mount;
 * all prop changes flow in imperatively (no react-rendered scene graph).
 */
export function GameCanvas({
  board,
  mode,
  placements,
  roll,
  robberMode,
  robberTileId,
  production,
  onPick,
  onHover,
  onRollDone,
}: GameCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<GameView | null>(null)

  useEffect(() => {
    const view = new GameView(hostRef.current!)
    viewRef.current = view
    return () => {
      view.dispose()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    viewRef.current?.buildBoard(board)
  }, [board])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.onPick = onPick
    view.onHover = onHover
    view.onRollDone = onRollDone
    view.setBuildMode(mode)
  }, [mode, onPick, onHover, onRollDone])

  useEffect(() => {
    viewRef.current?.setPlacements(placements)
  }, [placements])

  useEffect(() => {
    if (roll) viewRef.current?.rollDice(roll.die1, roll.die2)
  }, [roll])

  useEffect(() => {
    viewRef.current?.setRobberMode(robberMode)
  }, [robberMode])

  useEffect(() => {
    viewRef.current?.setRobberTile(robberTileId)
  }, [robberTileId])

  useEffect(() => {
    if (production) viewRef.current?.showProduction(production.tileIds)
  }, [production])

  return <div ref={hostRef} className="game-canvas" />
}

import { useEffect, useRef } from 'react'
import {
  GameView,
  type BuildMode,
  type HoverInfo,
  type PickTarget,
  type PlacementState,
} from '../three/GameView'
import type { Board } from '../game/board'

interface GameCanvasProps {
  board: Board
  mode: BuildMode
  placements: PlacementState
  onPick: (target: PickTarget) => void
  onHover: (info: HoverInfo | null) => void
}

/**
 * React ↔ Three.js bridge. Owns exactly one GameView instance per mount;
 * all prop changes flow in imperatively (no react-rendered scene graph).
 */
export function GameCanvas({ board, mode, placements, onPick, onHover }: GameCanvasProps) {
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
    view.setBuildMode(mode)
  }, [mode, onPick, onHover])

  useEffect(() => {
    viewRef.current?.setPlacements(placements)
  }, [placements])

  return <div ref={hostRef} className="game-canvas" />
}

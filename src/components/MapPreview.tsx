import { MAP_PRESETS, type MapPreset } from '../game/maps'
import { TERRAIN_INFO } from '../game/terrain'

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')

/** Hex center world position for the axial key `q,r` (mirrors board.ts). */
function tilePos(key: string): { x: number; z: number } {
  const [q, r] = key.split(',').map(Number)
  return { x: 1.5 * q, z: Math.sqrt(3) * (r + q / 2) }
}

/**
 * Small SVG island rendered from a preset's terrain table — used in the map
 * picker and room header so everyone can see the fixed island before playing.
 * Pointy-corner hexes match the 3D board's orientation.
 */
export function MapPreview({ preset, size = 132 }: { preset: MapPreset | null; size?: number }) {
  const W = 7.2 // island spans x ∈ [-3.5, 3.5]
  const entries = preset ? Object.entries(preset.tiles) : []
  return (
    <svg
      className="map-preview"
      width={size}
      height={size * 0.9}
      viewBox={`${-W / 2} ${-W * 0.45} ${W} ${W * 0.9}`}
      role="img"
      aria-label={preset ? preset.name : 'random island'}
    >
      {preset ? (
        entries.map(([key, terrain]) => {
          const { x, z } = tilePos(key)
          const info = TERRAIN_INFO[terrain]
          return (
            <g key={key}>
              <polygon points={hexPoints(x, z, 0.96)} fill={hex(info.color)} stroke={hex(info.accent)} strokeWidth={0.06} />
              {terrain === 'desert' && <circle cx={x} cy={z} r={0.16} fill={hex(info.accent)} opacity={0.6} />}
            </g>
          )
        })
      ) : (
        <g opacity={0.9}>
          <polygon points={hexPoints(0, 0, 3.4)} fill="#3c6f79" opacity={0.35} />
          <text x={0} y={0.2} textAnchor="middle" fontSize={0.75} fill="#d9e6e2">
            🎲
          </text>
        </g>
      )}
    </svg>
  )
}

/** Six corner points of a pointy-corner hex at (x, z) with circumradius r. */
function hexPoints(x: number, z: number, r: number): string {
  return Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 180) * (60 * k)
    return `${(x + Math.cos(a) * r).toFixed(2)},${(z + Math.sin(a) * r).toFixed(2)}`
  }).join(' ')
}

export { MAP_PRESETS }

import { describe, expect, it } from 'vitest'
import { MAP_PRESETS, mapPresetById, validatePreset, OFFICIAL_COUNTS } from './maps'
import { TERRAIN_COUNTS } from './terrain'

describe('fixed map presets', () => {
  it('ships at least the four CWC 2025 islands, all valid', () => {
    expect(MAP_PRESETS.length).toBeGreaterThanOrEqual(4)
    for (const preset of MAP_PRESETS) expect(validatePreset(preset)).toBe(true)
  })

  it('ids are unique and lookup works (null for random/unknown)', () => {
    expect(new Set(MAP_PRESETS.map((m) => m.id)).size).toBe(MAP_PRESETS.length)
    expect(mapPresetById('cwc2025-1')?.id).toBe('cwc2025-1')
    expect(mapPresetById(null)).toBeNull()
    expect(mapPresetById('nope')).toBeNull()
  })

  it('each island differs (no duplicated layouts)', () => {
    const seen = new Set(MAP_PRESETS.map((m) => JSON.stringify(m.tiles)))
    expect(seen.size).toBe(MAP_PRESETS.length)
  })

  it('official composition matches the terrain table', () => {
    for (const [terrain, count] of TERRAIN_COUNTS) {
      expect(OFFICIAL_COUNTS[terrain]).toBe(count)
    }
  })

  it('rejects malformed presets', () => {
    expect(validatePreset({ ...MAP_PRESETS[0], tiles: { ...MAP_PRESETS[0].tiles, '9,9': 'forest' } })).toBe(false)
    const swapped = { ...MAP_PRESETS[0], tiles: { ...MAP_PRESETS[0].tiles } }
    const first = Object.keys(swapped.tiles)[0]
    swapped.tiles[first] = 'forest' // breaks the 4/4/4/3/3/1 balance
    expect(validatePreset(swapped)).toBe(false)
  })
})

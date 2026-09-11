import { describe, expect, it } from 'vitest'
import { CUES, eventCue } from './GameSound'

const state = { roll: 2, buildings: 8, cities: 0, robber: '0,0', journal: '', winner: null, playedCard: 'knight:1', seed: 12 }
describe('table audio events', () => {
  it('uses the requested files', () => {
    expect(CUES.intro.file).toBe('imperial_march.mp3')
    expect(CUES.knight.file).toBe('knight_moat3.mp3')
    expect(CUES.city.file).toBe('starship-1.mp3')
  })
  it('announces consecutive knights ahead of robber movement', () => {
    expect(eventCue(state, { ...state, playedCard: 'knight:2', robber: '1,0' })).toBe('knight')
  })
  it('recognizes a city upgrade and stays quiet when it is undone', () => {
    expect(eventCue(state, { ...state, cities: 1 })).toBe('city')
    expect(eventCue({ ...state, cities: 1 }, state)).toBeNull()
  })
  it('stays quiet on unchanged state and restarts the intro for a new island', () => {
    expect(eventCue(state, { ...state })).toBeNull()
    expect(eventCue(state, { ...state, seed: 13, buildings: 0, roll: null })).toBe('intro')
  })
})

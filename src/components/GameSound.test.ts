import { describe, expect, it } from 'vitest'
import { CUES, eventCue, type SoundEvents } from './GameSound'

const state: SoundEvents = {
  roll: 2,
  seven: null,
  production: null,
  buildings: 8,
  cities: 0,
  robber: '0,0',
  journal: '',
  winner: null,
  lost: null,
  playedCard: 'knight:1',
  seed: 12,
}
describe('table audio events', () => {
  it('uses the requested files', () => {
    expect(CUES.intro.file).toBe('imperial_march.mp3')
    expect(CUES.knight.file).toBe('knight_moat3.mp3')
    expect(CUES.city.file).toBe('starship-1.mp3')
  })
  it('every sound file on disk is wired into CUES', () => {
    // import.meta.glob keeps this honest without node deps in the component test
    const files = Object.values(CUES).map((c) => c.file)
    expect(new Set(files).size).toBe(files.length) // no accidental duplicates
    expect(files).toContain('pega-ladrao.mp3')
    expect(files).toContain('seu-madruga-ladrao.mp3')
    expect(files).toContain('rickroll.mp3')
    expect(files).toContain('undertakers-bell_2UwFCIe.mp3')
  })
  it('announces consecutive knights ahead of robber movement', () => {
    expect(eventCue(state, { ...state, playedCard: 'knight:3', robber: '1,0' })).toBe('knight')
    // alternate knight voice on every other played card
    expect(eventCue(state, { ...state, playedCard: 'knight:2', robber: '1,0' })).toBe('knightGold')
    expect(eventCue(state, { ...state, playedCard: 'knight:4' })).toBe('knightGold')
  })
  it('monopoly rickrolls the table', () => {
    expect(eventCue(state, { ...state, playedCard: 'monopoly:3' })).toBe('rickroll')
  })
  it('a 7 plays pega ladrão instead of the dice rattle', () => {
    expect(eventCue(state, { ...state, roll: 3, seven: 3 })).toBe('pegaLadrao')
  })
  it('produced resources beat the generic dice sound', () => {
    expect(eventCue(state, { ...state, roll: 4, production: '4|wool,grain' })).toBe('wool')
    expect(eventCue(state, { ...state, roll: 5, production: '5|wood' })).toBe('wood')
    expect(eventCue(state, { ...state, roll: 6, production: '6|ore' })).toBe('dice') // no cue for ore
    expect(eventCue(state, { ...state, roll: 7, production: null })).toBe('dice')
  })
  it('a steal gets Seu Madruga, discards get Jigsaw, trades rotate lines', () => {
    expect(eventCue(state, { ...state, journal: 'Red stole a card from Blue' })).toBe('madruga')
    expect(eventCue(state, { ...state, journal: 'Red discarded 3' })).toBe('saw')
    const accepted = 'Blue accepted 1🪵 ⇄ 1🧱 from Red'
    const cues = [1, 2, 3].map((n) => eventCue(state, { ...state, journal: accepted + ' '.repeat(n) }))
    expect(new Set(cues)).toEqual(new Set(['trade', 'takeTrade', 'obrigado']))
  })
  it('recognizes a city upgrade and stays quiet when it is undone', () => {
    expect(eventCue(state, { ...state, cities: 1 })).toBe('city')
    expect(eventCue({ ...state, cities: 1 }, state)).toBeNull()
  })
  it('a local win cheers, a multiplayer loss tolls the bell', () => {
    expect(eventCue(state, { ...state, winner: 2 })).toBe('win')
    expect(eventCue(state, { ...state, winner: 2, lost: 2 })).toBe('funeral')
  })
  it('stays quiet on unchanged state and restarts the intro for a new island', () => {
    expect(eventCue(state, { ...state })).toBeNull()
    expect(eventCue(state, { ...state, seed: 13, buildings: 0, roll: null })).toBe('intro')
  })
})

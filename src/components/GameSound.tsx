import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { GameIcon } from './GameIcon'

export const CUES = {
  intro: { label: 'Imperial march', file: 'imperial_march.mp3' },
  knight: { label: 'Knight', file: 'knight_moat3.mp3' },
  city: { label: 'City build', file: 'starship-1.mp3' },
  build: { label: 'Construction', file: 'warcraft-ii-sound-effects-orc-peon-grunt_-_work-complete.mp3' },
  dice: { label: 'Dice roll', file: 'shake-and-roll-dice-soundbible.mp3' },
  trade: { label: 'Fair trade', file: 'fair-trade.mp3' },
  robber: { label: 'Robber', file: 'thief.mp3' },
  win: { label: 'Victory', file: 'super-mario-beedoo_F3cwLoe.mp3' },
} as const
type Cue = keyof typeof CUES
interface SoundEvents { roll: number | null; buildings: number; cities: number; robber: string; journal: string; winner: number | null; playedCard?: string; seed?: number }

export function eventCue(old: SoundEvents, next: SoundEvents): Cue | null {
  if (next.seed !== old.seed) return 'intro'
  if (next.winner !== null && next.winner !== old.winner) return 'win'
  if (next.playedCard !== old.playedCard && next.playedCard?.startsWith('knight:')) return 'knight'
  if (next.cities > old.cities) return 'city'
  if (next.buildings > old.buildings) return 'build'
  if (next.roll !== old.roll && next.roll !== null) return 'dice'
  if (next.robber !== old.robber) return 'robber'
  if (next.journal !== old.journal && /accepted|traded/.test(next.journal)) return 'trade'
  return null
}

const AudioContext = createContext<{
  enabled: boolean; toggle: () => void; selected: Cue; select: (cue: Cue) => void;
  play: (cue: Cue) => void; stop: () => void; playing: boolean; status: string;
  volume: number; setVolume: (value: number) => void;
} | null>(null)

/** One audio channel, shared by the header toggle and table-side transport. */
export function GameAudioProvider({ children, ...events }: SoundEvents & { children: ReactNode }) {
  const [enabled, setEnabled] = useState(true)
  const [selected, select] = useState<Cue>('intro')
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [volume, setVolumeState] = useState(0.3)
  const enabledRef = useRef(true)
  const volumeRef = useRef(0.3)
  const audio = useRef<HTMLAudioElement | null>(null)
  const generation = useRef(0)
  const removeRetry = useRef<(() => void) | null>(null)
  const previous = useRef(events)

  const stop = useCallback(() => {
    generation.current++
    removeRetry.current?.()
    removeRetry.current = null
    if (audio.current) { audio.current.onended = null; audio.current.pause(); audio.current = null }
    setPlaying(false)
    setStatus('Ready')
  }, [])

  const play = useCallback((cue: Cue, retryOnGesture = false) => {
    stop()
    if (!enabledRef.current) return
    const id = generation.current
    const clip = new Audio('/sounds/' + CUES[cue].file)
    clip.volume = volumeRef.current
    audio.current = clip
    select(cue)
    const attempt = () => {
      if (id !== generation.current || !enabledRef.current) return
      void clip.play().then(() => {
        if (id !== generation.current) { clip.pause(); return }
        removeRetry.current?.()
        removeRetry.current = null
        setPlaying(true)
        setStatus('Playing')
      }).catch((error: unknown) => {
        if (id !== generation.current) return
        const blocked = error instanceof DOMException && error.name === 'NotAllowedError'
        setStatus(blocked ? 'Tap play to listen' : 'Audio unavailable')
        if (!retryOnGesture || !blocked || removeRetry.current) return
        const retry = (event: Event) => {
          // Audio controls handle their own gesture; never restart the intro over them.
          if (event.target instanceof Element && event.target.closest('[data-audio-control]')) return
          removeRetry.current?.()
          removeRetry.current = null
          attempt()
        }
        window.addEventListener('pointerdown', retry)
        window.addEventListener('keydown', retry)
        removeRetry.current = () => { window.removeEventListener('pointerdown', retry); window.removeEventListener('keydown', retry) }
      })
    }
    clip.onended = () => { if (id === generation.current) { setPlaying(false); setStatus('Finished') } }
    attempt()
  }, [stop])

  useEffect(() => { play('intro', true); return stop }, [play, stop])
  useEffect(() => {
    const cue = eventCue(previous.current, events)
    previous.current = events
    if (cue && enabledRef.current) play(cue, cue === 'intro')
  }, [events.roll, events.buildings, events.cities, events.robber, events.journal, events.winner, events.playedCard, events.seed, play])

  const toggle = () => {
    enabledRef.current = !enabledRef.current
    setEnabled(enabledRef.current)
    if (!enabledRef.current) stop()
  }
  const manualPlay = (cue: Cue) => { enabledRef.current = true; setEnabled(true); play(cue) }
  const setVolume = (value: number) => { volumeRef.current = value; setVolumeState(value); if (audio.current) audio.current.volume = value }
  return <AudioContext.Provider value={{ enabled, toggle, selected, select, play: manualPlay, stop, playing, status, volume, setVolume }}>{children}</AudioContext.Provider>
}

export function SoundToggle() {
  const sound = useContext(AudioContext)!
  return <button className="btn btn-small" data-audio-control aria-pressed={sound.enabled} title="Toggle automatic game sounds" onClick={sound.toggle}>{sound.enabled ? '♫ Sound on' : '♪ Sound off'}</button>
}

export function Soundboard() {
  const sound = useContext(AudioContext)!
  return <section className="soundboard" aria-label="Table soundboard" data-audio-control>
    <div className="soundboard-heading"><span className="eyebrow">TABLE SOUNDS</span><small aria-live="polite">{sound.status}</small></div>
    <div className="soundboard-transport"><button className="sound-play" aria-label={sound.playing ? 'Stop audio' : 'Play ' + CUES[sound.selected].label} onClick={() => sound.playing ? sound.stop() : sound.play(sound.selected)}>{sound.playing ? '■' : '▶'}</button>
      <label><span className="sr-only">Choose a table sound</span><select value={sound.selected} onChange={event => { sound.stop(); sound.select(event.target.value as Cue) }}>{Object.entries(CUES).map(([cue, info]) => <option key={cue} value={cue}>{info.label}</option>)}</select></label>
    </div>
    <div className="soundboard-grid">{(['intro', 'knight', 'city'] as Cue[]).map(cue => <button key={cue} className="soundboard-button" title={'Play ' + CUES[cue].label} onClick={() => sound.play(cue)}>{cue === 'intro' ? <span aria-hidden="true">♫</span> : <GameIcon name={cue === 'knight' ? 'knight' : 'city'} />}{cue === 'intro' ? 'March' : cue === 'city' ? 'City' : 'Knight'}</button>)}</div>
    <label className="sound-volume"><span>Volume</span><input aria-label="Sound volume" type="range" min="0" max="1" step="0.05" value={sound.volume} onChange={event => sound.setVolume(Number(event.target.value))} /></label>
  </section>
}

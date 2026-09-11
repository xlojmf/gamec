import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { PLAYER_COLORS, PLAYER_NAMES } from '#/three/GameView'
import {
  loadCreatorToken,
  loadMpSession,
  roomsApiBase,
  saveCreatorToken,
  saveMpSession,
  type MpSession,
  type RoomInfo,
  type RoomPlayers,
} from '#/multiplayer/session'

export const Route = createFileRoute('/online')({
  validateSearch: (search: Record<string, unknown>): { code?: string } => ({
    code:
      typeof search.code === 'string'
        ? search.code.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6) || undefined
        : undefined,
  }),
  component: OnlinePage,
})

function OnlinePage() {
  const navigate = useNavigate()
  const { code } = Route.useSearch()

  return (
    <main className="landing">
      {code ? (
        <RoomView code={code} />
      ) : (
        <LobbyHome onCreateOrJoin={(c) => navigate({ to: '/online', search: { code: c } })} />
      )}
    </main>
  )
}

// -- lobby home ----------------------------------------------------------------

function LobbyHome({ onCreateOrJoin }: { onCreateOrJoin: (code: string) => void }) {
  const [joinCode, setJoinCode] = useState('')
  const [numPlayers, setNumPlayers] = useState<3 | 4>(4)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createRoom = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${roomsApiBase()}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ numPlayers }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { code: string; creatorToken: string }
      saveCreatorToken(data.code, data.creatorToken)
      onCreateOrJoin(data.code)
    } catch {
      setError('Cannot reach the game server. Please try again shortly.')
    } finally {
      setBusy(false)
    }
  }

  const joinRoom = () => {
    const c = joinCode.toUpperCase().replace(/[^A-Z2-9]/g, '')
    if (c.length < 4) {
      setError('room codes are 4 characters')
      return
    }
    onCreateOrJoin(c)
  }

  return (
    <section className="hero">
      <p className="hero-kicker">multiplayer · up to 4 settlers · one shared island</p>
      <h1>
        Play <span className="accent">online</span>
      </h1>
      <p className="hero-sub">
        Create a room, share the 4-letter code, take a seat. Everyone plays in their own browser —
        hidden hands, live dice, same island.
      </p>
      <div className="count-picker" role="radiogroup" aria-label="players">
        <span className="alias-label">players</span>
        {[3, 4].map((n) => (
          <button
            key={n}
            role="radio"
            aria-checked={numPlayers === n}
            className={`count-chip ${numPlayers === n ? 'count-chip-active' : ''}`}
            onClick={() => setNumPlayers(n as 3 | 4)}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="hero-actions">
        <button className="btn btn-primary" disabled={busy} onClick={createRoom}>
          {busy ? 'Creating…' : '🌐 Create room'}
        </button>
        <div className="join-row">
          <input
            className="join-input"
            value={joinCode}
            placeholder="CODE"
            maxLength={6}
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => {
              setJoinCode(e.target.value.toUpperCase())
              setError(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && joinRoom()}
          />
          <button className="btn" onClick={joinRoom}>
            Join room
          </button>
        </div>
        <Link to="/game" search={{}} className="btn">
          🎮 Hotseat instead
        </Link>
      </div>
      {error && <p className="small join-error">{error}</p>}
    </section>
  )
}

// -- room view -------------------------------------------------------------------

function RoomView({ code }: { code: string }) {
  const navigate = useNavigate()
  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<MpSession | null | 'pending'>('pending')
  const [name, setName] = useState('Settler')
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)
  const [starting, setStarting] = useState(false)
  const [isCreator, setIsCreator] = useState(false)
  const aliasLoaded = useRef(false)

  useEffect(() => {
    setIsCreator(loadCreatorToken(code) !== null)
  }, [code])

  // adopt the stored alias after mount (SSR-safe), then persist edits
  useEffect(() => {
    if (!aliasLoaded.current) {
      aliasLoaded.current = true
      try {
        const stored = localStorage.getItem('catan-alias')
        if (stored) setName(stored)
      } catch {
        // storage disabled — alias just won't persist
      }
      return
    }
    try {
      localStorage.setItem('catan-alias', name)
    } catch {
      // ignore
    }
  }, [name])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch(`${roomsApiBase()}/rooms/${code}`)
        if (!alive) return
        if (res.status === 404) {
          setError('room not found — check the code')
          setRoom(null)
          return
        }
        if (!res.ok) throw new Error(String(res.status))
        const info = (await res.json()) as RoomInfo
        setRoom(info)
        setError(null)
      } catch {
        if (alive) setError('cannot reach the game server')
      }
    }
    void tick()
    const interval = setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [code])

  // adopt an existing session for this room (page refresh / invite link return)
  useEffect(() => {
    if (!room) return
    const existing = loadMpSession(room.matchID)
    if (!existing) {
      setSession(null)
      return
    }
    if (existing.roomCode === code) {
      setSession(existing)
    } else {
      const fixed = { ...existing, roomCode: code }
      saveMpSession(fixed)
      setSession(fixed)
    }
  }, [room?.matchID, code]) // eslint-disable-line react-hooks/exhaustive-deps

  const takeSeat = useCallback(
    async (seat: number) => {
      if (!room) return
      try {
        const res = await fetch(`${roomsApiBase()}/rooms/${code}/join`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerID: String(seat), playerName: name || 'Settler' }),
        })
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as { matchID: string; playerID: number; playerCredentials: string }
        const s: MpSession = {
          matchID: data.matchID,
          playerID: Number(data.playerID),
          credentials: data.playerCredentials,
          roomCode: code,
        }
        saveMpSession(s)
        setSession(s)
      } catch {
        setError('seat taken — pick another')
      }
    },
    [room, code, name],
  )

  const seated = room?.players.filter((p) => p.name).length ?? 0
  const seats = room?.players.length ?? 4
  const allSeated = seated === seats
  const started = room?.started === true
  const inviteLink = typeof window !== 'undefined' ? `${window.location.origin}/online?code=${code}` : ''

  const copy = async (what: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(what === 'code' ? code : inviteLink)
      setCopied(what)
      setTimeout(() => setCopied(null), 1800)
    } catch {
      // clipboard unavailable (permissions / http) — select-all fallback omitted for brevity
    }
  }

  const startGame = async () => {
    const token = loadCreatorToken(code)
    if (!token || !room) return
    setStarting(true)
    try {
      const res = await fetch(`${roomsApiBase()}/rooms/${code}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorToken: token }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setRoom({ ...room, started: true })
    } catch {
      setError('could not start the game')
    } finally {
      setStarting(false)
    }
  }

  // when the creator starts, everyone seated hops into the island
  useEffect(() => {
    if (started && session && session !== 'pending') {
      navigate({ to: '/game', search: { match: session.matchID, seat: session.playerID, players: seats } })
    }
  }, [started, session, seats, navigate])

  return (
    <section className="hero room">
      <p className="hero-kicker">
        room code{' '}
        <button className="code-chip" title="click to copy the code" onClick={() => void copy('code')}>
          {code}
        </button>
        <button className="code-copy-hint" title="copy the invite link instead" onClick={() => void copy('link')}>
          {copied === 'link' ? 'link copied ✓' : '🔗 invite link'}
        </button>
        {copied === 'code' && <span className="code-copy-hint code-copied">code copied ✓</span>}
      </p>
      <h1>
        Take a <span className="accent">seat</span>
      </h1>

      <div className="alias-row">
        <label className="alias-label" htmlFor="alias">
          your alias
        </label>
        <input
          id="alias"
          className="join-input alias-input"
          value={name}
          maxLength={24}
          placeholder="Settler"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <p className="hero-sub">
        {started
          ? 'the game is starting — hopping into the island…'
          : allSeated
            ? isCreator
              ? 'all seats taken — start the game when everyone is ready!'
              : 'all seats taken — waiting for the host to start…'
            : `waiting for ${seats - seated} more settler${seats - seated === 1 ? '' : 's'}…`}
      </p>

      <div className="seat-grid">
        {(room?.players ?? Array.from({ length: seats }, (_, id): RoomPlayers => ({ id }))).map((p) => {
          const mine = session && session !== 'pending' && session.playerID === p.id
          return (
            <div key={p.id} className={`seat ${p.name ? 'seat-taken' : ''}`}>
              <span className="chip-dot" style={{ '--chip': `#${PLAYER_COLORS[p.id].toString(16).padStart(6, '0')}` } as React.CSSProperties} />
              <div className="seat-body">
                <strong>{PLAYER_NAMES[p.id]}</strong>
                <small>{p.name ? p.name : 'empty seat'}</small>
              </div>
              {mine ? (
                <span className="seat-you">you</span>
              ) : p.name ? null : (
                <button className="btn btn-small" disabled={!room || !!error} onClick={() => void takeSeat(p.id)}>
                  sit here
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="hero-actions">
        {isCreator && allSeated && !started ? (
          <button className="btn btn-primary" disabled={starting} onClick={() => void startGame()}>
            {starting ? 'Starting…' : '🚀 Start game'}
          </button>
        ) : session && session !== 'pending' ? (
          <Link className="btn btn-primary" to="/game" search={{ match: session.matchID, seat: session.playerID, players: seats }}>
            ▶ Enter the island
          </Link>
        ) : (
          <button className="btn" disabled>
            ▶ Enter the island
          </button>
        )}
        <Link to="/online" search={{}} className="btn">
          ⟵ Back
        </Link>
      </div>

      {error && <p className="small join-error">{error}</p>}
      <p className="muted small">
        {seats} seats · fill in any order · refresh safely reconnects to your seat
      </p>
    </section>
  )
}

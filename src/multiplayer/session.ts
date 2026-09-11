/**
 * Browser-side multiplayer helpers (M12, PRD §7).
 *
 * The game server (docker `game` service) exposes ws + lobby + rooms on :8000.
 * Player credentials live in sessionStorage so a refresh reconnects to the
 * same seat. URL `?server=host:port` overrides the default for remote hosts.
 */

export interface MpSession {
  matchID: string
  playerID: number
  credentials: string
  roomCode?: string
}

export function gameServerHost(): string {
  const explicit = new URLSearchParams(window.location.search).get('server')
  const endpoint = explicit || import.meta.env.VITE_GAME_SERVER_URL || `${window.location.hostname}:${import.meta.env.VITE_GAME_SERVER_PORT || 8000}`
  const url = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `${window.location.protocol}//${endpoint}`)
  return url.origin
}

export function roomsApiBase(): string {
  return gameServerHost()
}

export function mpSessionKey(matchID: string): string {
  return `catan-mp-${matchID}`
}

export function saveMpSession(session: MpSession): void {
  try {
    sessionStorage.setItem(mpSessionKey(session.matchID), JSON.stringify(session))
  } catch {
    // private mode / storage disabled — reconnect just won't survive refresh
  }
}

export function loadMpSession(matchID: string): MpSession | null {
  try {
    const raw = sessionStorage.getItem(mpSessionKey(matchID))
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<MpSession>
    // be forgiving about playerID coming back as a string (older sessions / JSON)
    const playerID = Number(s.playerID)
    if (s.matchID !== matchID || !Number.isInteger(playerID) || typeof s.credentials !== 'string') return null
    return { matchID: s.matchID, playerID, credentials: s.credentials, roomCode: s.roomCode }
  } catch {
    return null
  }
}

export interface RoomPlayers {
  id: number
  name?: string
}

export interface RoomInfo {
  code: string
  matchID: string
  started?: boolean
  players: RoomPlayers[]
}

/** The room creator's start token (per room, sessionStorage). */
export function creatorKey(code: string): string {
  return `catan-creator-${code}`
}

export function saveCreatorToken(code: string, token: string): void {
  try {
    sessionStorage.setItem(creatorKey(code), token)
  } catch {
    // ignore
  }
}

export function loadCreatorToken(code: string): string | null {
  try {
    return sessionStorage.getItem(creatorKey(code))
  } catch {
    return null
  }
}

/**
 * boardgame.io multiplayer game server (M12, PRD §7).
 *
 * One port serves everything:
 *   - the ws transport clients connect to (boardgame.io SocketIO)
 *   - the built-in Lobby REST API (/games/*)
 *   - a thin rooms API mapping friendly 4-char join codes → matchIDs:
 *
 *       GET  /health                    → 'ok' (liveness probe)
 *       POST /rooms                     → { code, matchID, numPlayers, creatorToken }
 *       GET  /rooms/:code               → { code, matchID, started, players }
 *       POST /rooms/:code/join          → { matchID, playerID, playerCredentials }
 *       POST /rooms/:code/start         → { started: true }   (creator only)
 *       POST /rooms/:code/rematch       → { matchID }         (creator only, fresh island)
 *
 * Persistence (PRD stretch, now done):
 *   - FLATFILE_DIR: boardgame.io matches (state + metadata) via the FlatFile db
 *   - ROOMS_FILE (defaults to $FLATFILE_DIR/rooms.json): the rooms registry
 *
 * Stall handling: a watchdog auto-plays for seats that idle past
 * TURN_TIMEOUT_SECONDS (default 180) so an abandoned browser can't freeze a
 * match — it rolls, resolves the robber flow, and ends the turn.
 *
 *   PORT=8000 node dist/game/gameServer.js
 */

import { Server, FlatFile } from 'boardgame.io/server'
import { Client } from 'boardgame.io/client'
import { SocketIO } from 'boardgame.io/multiplayer'
import { CatanGame, boardFor, connectedRoadEdges, validSetupEdges, validSetupVertices } from '#/game/catan'
import type { GameState } from '#/game/catan'
import { RoomsStore, type StoredRoom } from './roomsStore'

const PORT = Number(process.env.PORT ?? 8000)
const FLATFILE_DIR = process.env.FLATFILE_DIR ?? ''
const ROOMS_FILE = process.env.ROOMS_FILE ?? (FLATFILE_DIR ? `${FLATFILE_DIR}/rooms.json` : '')
const TURN_TIMEOUT_MS = Math.max(5, Number(process.env.TURN_TIMEOUT_SECONDS) || 180) * 1000

/** Unambiguous alphabet — no 0/O/1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 4

const rooms = new RoomsStore(ROOMS_FILE || null)

function randomCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return code
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)
}

async function lobbyApi(baseUrl: string, path: string, init?: { method?: string; body?: string }): Promise<Record<string, unknown>> {
  const res = await fetch(baseUrl + path, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body,
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) throw new Error(`lobby api ${path} → ${res.status}: ${JSON.stringify(body)}`)
  return body ?? {}
}

// Minimal structural koa context — avoids depending on koa's type packages.
interface RoomCtx {
  path: string
  method: string
  status: number
  body: unknown
  set(name: string, value: string): void
  req: AsyncIterable<Buffer>
}

async function readJsonBody(ctx: RoomCtx): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

type KoaLikeApp = { use(middleware: (ctx: RoomCtx, next: () => Promise<void>) => Promise<void>): unknown }
type GameServerLike = {
  app: KoaLikeApp
  db: { fetch(matchID: string, opts: { state?: boolean; metadata?: boolean }): Promise<{ state?: unknown; metadata?: unknown }> }
  run(port: number): Promise<unknown>
}

interface BgioCtxShape {
  currentPlayer: string
  turn: number
  phase: string
  activePlayers: Record<string, string | { stage: string }> | null
  gameover: unknown
}

interface FullState {
  G: GameState
  ctx: BgioCtxShape
}

/** Create a fresh match with the room's parameters (used by create + rematch). */
async function createMatch(
  baseUrl: string,
  opts: { numPlayers: number; playerNames?: string[] },
): Promise<string> {
  const seed = Math.floor(Math.random() * 0x7fffffff)
  const { matchID } = await lobbyApi(baseUrl, `/games/${CatanGame.name}/create`, {
    method: 'POST',
    body: JSON.stringify({
      numPlayers: opts.numPlayers,
      setupData: { seed, numPlayers: opts.numPlayers, playerNames: opts.playerNames },
    }),
  })
  if (typeof matchID !== 'string') throw new Error('create returned no matchID')
  return matchID
}

/** Start ws + lobby + rooms API on `port` (used by the CLI and by e2e tests). */
export async function startGameServer(port: number = PORT, opts: { turnTimeoutMs?: number } = {}): Promise<void> {
  const { app, db, run } = Server({
    games: [CatanGame],
    ...(FLATFILE_DIR
      ? {
          // persisted matches — rooms/rooms.json rides along in the same dir
          db: new FlatFile({ dir: FLATFILE_DIR, logging: false, ttl: false }) as never,
        }
      : {}),
    // Fan project with no accounts: accept any origin for ws + lobby API.
    origins: true,
  }) as unknown as GameServerLike

  const BASE = `http://127.0.0.1:${port}`

  app.use(async (ctx, next) => {
    ctx.set('Access-Control-Allow-Origin', '*')
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    ctx.set('Access-Control-Allow-Headers', 'content-type')
    if (ctx.method === 'OPTIONS') {
      ctx.status = 204
      return
    }

    if (ctx.path === '/health' && ctx.method === 'GET') {
      ctx.status = 200
      ctx.body = 'ok'
      return
    }

    if (ctx.path === '/rooms' && ctx.method === 'POST') {
      try {
        const body = await readJsonBody(ctx)
        const numPlayers = body.numPlayers === 3 ? 3 : 4
        const matchID = await createMatch(BASE, { numPlayers })
        let code = randomCode()
        while (rooms.has(code)) code = randomCode()
        rooms.set(code, {
          matchID,
          numPlayers,
          started: false,
          creatorToken: randomToken(),
          seatNames: {},
          seatCredentials: {},
          updatedAt: '',
        })
        const room = rooms.get(code)!
        console.log(`[rooms] ${code} → ${matchID} (${numPlayers} players)`)
        ctx.status = 201
        ctx.body = { code, matchID, numPlayers, creatorToken: room.creatorToken }
      } catch (err) {
        console.error('[rooms] create failed:', err instanceof Error ? err.message : err)
        ctx.status = 502
        ctx.body = { error: 'failed to create match' }
      }
      return
    }

    const room = /^\/rooms\/([A-Z2-9]{4,6})$/.exec(ctx.path)
    if (room && ctx.method === 'GET') {
      const entry = rooms.get(room[1])
      if (!entry) {
        ctx.status = 404
        ctx.body = { error: 'room not found' }
        return
      }
      const match = await lobbyApi(BASE, `/games/${CatanGame.name}/${entry.matchID}`)
      ctx.status = 200
      ctx.body = { code: room[1], matchID: entry.matchID, started: entry.started, players: match.players }
      return
    }

    const join = /^\/rooms\/([A-Z2-9]{4,6})\/join$/.exec(ctx.path)
    if (join && ctx.method === 'POST') {
      const entry = rooms.get(join[1])
      if (!entry) {
        ctx.status = 404
        ctx.body = { error: 'room not found' }
        return
      }
      const body = await readJsonBody(ctx)
      const playerID = String(body.playerID ?? '')
      const playerName = String(body.playerName ?? '').slice(0, 24) || 'Settler'
      if (!/^[0-3]$/.test(playerID) || Number(playerID) >= entry.numPlayers) {
        ctx.status = 400
        ctx.body = { error: `playerID must be 0–${entry.numPlayers - 1}` }
        return
      }
      try {
        const res = await lobbyApi(BASE, `/games/${CatanGame.name}/${entry.matchID}/join`, {
          method: 'POST',
          body: JSON.stringify({ playerID, playerName }),
        })
        entry.seatNames[playerID] = playerName
        entry.seatCredentials[playerID] = String(res.playerCredentials ?? '')
        rooms.set(join[1], entry)
        ctx.status = 200
        ctx.body = { code: join[1], matchID: entry.matchID, playerID: Number(playerID), playerCredentials: res.playerCredentials }
      } catch (err) {
        console.error(`[rooms] join ${join[1]} seat ${playerID} failed:`, err instanceof Error ? err.message : err)
        ctx.status = 409
        ctx.body = { error: 'seat taken or unavailable' }
      }
      return
    }

    const start = /^\/rooms\/([A-Z2-9]{4,6})\/start$/.exec(ctx.path)
    if (start && ctx.method === 'POST') {
      const entry = rooms.get(start[1])
      if (!entry) {
        ctx.status = 404
        ctx.body = { error: 'room not found' }
        return
      }
      const body = await readJsonBody(ctx)
      if (String(body.creatorToken ?? '') !== entry.creatorToken) {
        ctx.status = 403
        ctx.body = { error: 'only the room creator can start the game' }
        return
      }
      entry.started = true
      rooms.set(start[1], entry)
      console.log(`[rooms] ${start[1]} started (${entry.numPlayers} players)`)
      ctx.status = 200
      ctx.body = { code: start[1], started: true }
      return
    }

    const rematch = /^\/rooms\/([A-Z2-9]{4,6})\/rematch$/.exec(ctx.path)
    if (rematch && ctx.method === 'POST') {
      const entry = rooms.get(rematch[1])
      if (!entry) {
        ctx.status = 404
        ctx.body = { error: 'room not found' }
        return
      }
      const body = await readJsonBody(ctx)
      if (String(body.creatorToken ?? '') !== entry.creatorToken) {
        ctx.status = 403
        ctx.body = { error: 'only the room creator can start a rematch' }
        return
      }
      try {
        // same room code & seats, fresh island — carried-over names, new credentials
        const names = Array.from({ length: entry.numPlayers }, (_, i) => entry.seatNames[String(i)])
        entry.matchID = await createMatch(BASE, { numPlayers: entry.numPlayers, playerNames: names })
        entry.started = false
        entry.seatCredentials = {}
        rooms.set(rematch[1], entry)
        console.log(`[rooms] ${rematch[1]} rematch → ${entry.matchID}`)
        ctx.status = 200
        ctx.body = { code: rematch[1], matchID: entry.matchID, started: false }
      } catch (err) {
        console.error(`[rooms] rematch ${rematch[1]} failed:`, err instanceof Error ? err.message : err)
        ctx.status = 502
        ctx.body = { error: 'failed to create rematch' }
      }
      return
    }

    await next()
  })

  await run(port)
  console.log(`⚓ Catan game server on :${port} — ws + lobby + rooms${FLATFILE_DIR ? ` (persisted at ${FLATFILE_DIR})` : ''}`)

  startWatchdog(port, db, opts.turnTimeoutMs ?? TURN_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Stall watchdog: auto-play for seats that idle past the turn timeout so an
// abandoned browser can't freeze the match for everyone else.
// ---------------------------------------------------------------------------

interface StallSnapshot {
  key: string
  since: number
}

const stallTracker = new Map<string, StallSnapshot>()
const takeovers = new Set<string>()

function stateKey(ctx: BgioCtxShape): string {
  return JSON.stringify([ctx.turn, ctx.currentPlayer, ctx.phase, ctx.activePlayers])
}

function startWatchdog(port: number, db: GameServerLike['db'], timeoutMs = TURN_TIMEOUT_MS): void {
  const interval = Math.min(10_000, Math.max(1_000, Math.round(timeoutMs / 3)))
  setInterval(() => {
    void (async () => {
      for (const [code, room] of rooms.entries()) {
        if (!room.started || takeovers.has(room.matchID)) continue
        try {
          const { state } = await db.fetch(room.matchID, { state: true })
          if (!state) continue
          const full = state as unknown as FullState
          if (full.ctx.gameover) continue

          const key = stateKey(full.ctx)
          const now = Date.now()
          const prev = stallTracker.get(room.matchID)
          if (!prev || prev.key !== key) {
            stallTracker.set(room.matchID, { key, since: now })
            continue
          }
          if (now - prev.since < timeoutMs) continue

          console.log(`[watchdog] ${code}: stalled ${Math.round((now - prev.since) / 1000)}s at ${key} — auto-playing`)
          takeovers.add(room.matchID)
          void autoPlay(`127.0.0.1:${port}`, room)
            .catch((err) => console.error(`[watchdog] ${code} takeover failed:`, err))
            .finally(() => {
              takeovers.delete(room.matchID)
              stallTracker.delete(room.matchID)
            })
        } catch {
          // match vanished between listing and fetching — ignore
        }
      }
    })()
  }, interval)
}

/** Connect as `seat` through the loopback socket. */
function seatClient(server: string, matchID: string, numPlayers: number, seat: number, credentials: string) {
  return Client({
    game: CatanGame,
    numPlayers,
    playerID: String(seat),
    credentials,
    matchID,
    multiplayer: SocketIO({ server }),
  })
}

async function settle(client: ReturnType<typeof Client>, pred: (s: FullState) => boolean, ms = 2500): Promise<FullState | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 60))
    const s = client.getState() as unknown as FullState | null
    if (s && pred(s)) return s
  }
  return null
}

/** Wait until the client's first state sync lands. */
async function ensureSynced(client: ReturnType<typeof Client>, ms = 2500): Promise<FullState | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = client.getState() as unknown as FullState | null
    if (s) return s
    await new Promise((r) => setTimeout(r, 60))
  }
  return null
}

/**
 * Drives one stuck match forward exactly as a returning player would:
 * opening roll → setup placements → discard/respond/robber/dev effects →
 * roll → end turn. Idempotent per invocation and bounded.
 */
export async function autoPlay(server: string, room: StoredRoom): Promise<void> {
  const clients: Array<ReturnType<typeof Client>> = []

  /** Connect as `seat` and wait for the first state sync (null on failure). */
  const ensureSeat = async (i: number): Promise<ReturnType<typeof Client> | null> => {
    if (clients[i]) return clients[i]
    const credentials = room.seatCredentials[String(i)]
    if (!credentials) return null
    const c = seatClient(server, room.matchID, room.numPlayers, i, credentials)
    c.start()
    clients[i] = c
    return (await ensureSynced(c)) ? c : null
  }
  const close = () => {
    for (const c of clients) if (c) c.stop()
  }

  try {
    const reader = await ensureSeat(0)
    if (!reader) return // no credentials at all — nothing we can do

    // the mover (or staged responder) drives progress; loop until the stuck
    // turn ends or the state stops changing (safety bound)
    for (let step = 0; step < 32; step++) {
      const s = reader.getState() as unknown as FullState | null
      if (!s) return
      const { G, ctx } = s
      if (ctx.gameover) return

      const mover = Number(ctx.currentPlayer)
      const moverClient = await ensureSeat(mover)

      if (ctx.phase === 'openingRoll') {
        if (!moverClient || G.openingRolls[mover] !== null) return
        moverClient.moves.openingRoll()
        await settle(reader, (n) => n.G.openingRolls[mover] !== null)
        continue
      }

      if (ctx.phase === 'setup') {
        if (!moverClient) return
        const v = validSetupVertices(G)[0]
        if (!v) return
        const e = validSetupEdges(G, v)[0]
        if (!e) return
        moverClient.moves.placeSetup(v, e)
        await settle(reader, (n) => n.G.setupPlacements > G.setupPlacements)
        continue
      }

      // main phase — resolve blocking sub-flows first (any seat may be stuck)
      if (G.robberStep === 'discard') {
        const pid = Number(Object.keys(G.pendingDiscards)[0])
        const c = await ensureSeat(pid)
        if (!c) return
        const mine = (c.getState() as unknown as FullState | null)?.G.hands[pid]
        if (!mine) return
        const required = G.pendingDiscards[pid]
        const cards: Record<string, number> = {}
        let left = required
        for (const r of ['wood', 'brick', 'grain', 'wool', 'ore'] as const) {
          const take = Math.min(mine[r], left)
          if (take > 0) {
            cards[r] = take
            left -= take
          }
        }
        if (left > 0) return
        c.moves.discardHalf(cards)
        await settle(reader, (n) => n.G.robberStep !== 'discard')
        continue
      }

      if (G.pendingTrade) {
        const c = await ensureSeat(G.pendingTrade.partner)
        if (!c) return
        c.moves.declineTrade()
        await settle(reader, (n) => !n.G.pendingTrade || n.G.pendingTrade.partner !== G.pendingTrade!.partner)
        continue
      }

      if (G.robberStep === 'move') {
        if (!moverClient) return
        const target = boardTileIds(G).find((t) => t !== G.robberTileId)
        if (!target) return
        moverClient.moves.moveRobber(target)
        await settle(reader, (n) => n.G.robberTileId !== G.robberTileId)
        continue
      }

      if (G.robberStep === 'steal') {
        if (!moverClient || !G.stealTargets?.length) return
        moverClient.moves.steal(G.stealTargets[0])
        await settle(reader, (n) => n.G.robberStep !== 'steal')
        continue
      }

      if (G.devStep === 'roadBuilding') {
        if (!moverClient) return
        const edges = connectedRoadEdges(G, mover)
        if (edges.length > 0 && G.roadBuildingLeft > 0) {
          moverClient.moves.placeFreeRoad(edges[0])
          await settle(reader, (n) => n.G.roadBuildingLeft < G.roadBuildingLeft || n.G.devStep !== 'roadBuilding')
        } else {
          moverClient.moves.endTurn()
          await settle(reader, (n) => Number(n.ctx.currentPlayer) !== mover)
        }
        continue
      }

      if (G.devStep === 'yearOfPlenty') {
        if (!moverClient) return
        const available = (['wood', 'brick', 'grain', 'wool', 'ore'] as const).filter((r) => G.bank[r] >= 1)
        if (available.length === 0) return
        moverClient.moves.takeYearOfPlenty(available[0], available[1] ?? available[0])
        await settle(reader, (n) => n.G.devStep !== 'yearOfPlenty')
        continue
      }

      if (!G.rolled) {
        if (!moverClient) return
        moverClient.moves.roll()
        await settle(reader, (n) => n.G.rolled || n.G.robberStep !== null)
        continue
      }

      // turn complete
      moverClient?.moves.endTurn()
      await settle(reader, (n) => Number(n.ctx.currentPlayer) !== mover)
      return
    }
  } finally {
    close()
  }
}

/** Robber destination candidates from the masked client state (public info). */
function boardTileIds(G: GameState): string[] {
  // tile ids are the axial "q,r" strings — rebuild from the seed (pure, cached)
  return boardFor(G.seed).tiles.map((t) => t.id)
}

// CLI entry (skipped under vitest, which sets NODE_ENV=test)
if (process.env.NODE_ENV !== 'test') {
  void startGameServer(PORT)
}

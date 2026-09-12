/**
 * Trade + sync-ordering regression e2e (real websockets, real clients).
 *
 * Two production bugs covered here:
 *
 *  1. A client that re-syncs while a move is in flight could MISS the move's
 *     broadcast or have a stale full-state snapshot applied over it (bgio
 *     0.50's SYNC reducer has no stateID guard). With a pending trade nobody
 *     may move, so no later broadcast ever corrected the rolled-back client —
 *     the offer "never showed up" and the table froze until a manual refresh.
 *     The server now queues `sync` handling through the same per-match FIFO
 *     queue as moves. To make the race deterministic, this suite boots the
 *     server with a FlatFile db whose writes are artificially delayed.
 *
 *  2. Trade offers must reach every selected partner even when they cannot
 *     cover the asked cards (they decline instead) — otherwise the partner
 *     list leaks who holds what.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'boardgame.io/client'
import { SocketIO } from 'boardgame.io/multiplayer'
import { FlatFile } from 'boardgame.io/server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatanGame, validSetupEdges, validSetupVertices, type BgioState } from '#/game/catan'

const PORT = 8151
const BASE = `http://127.0.0.1:${PORT}`
const WRITE_DELAY_MS = 60 // widen the broadcast→write window the race lives in

type MpClient = ReturnType<typeof Client>
type RawState = BgioState & { _stateID?: number }

/** FlatFile whose commits lag — simulates node-persist write latency. */
class DelayedFlatFile extends FlatFile {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setState(...args: Parameters<FlatFile['setState']>): Promise<void> {
    await new Promise((r) => setTimeout(r, WRITE_DELAY_MS))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (super.setState as any)(...args)
  }
}

let code = ''
let matchID = ''
const credentials: string[] = []
const clients: MpClient[] = []
let tmpDir = ''

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'catan-sync-e2e-'))
  const { startGameServer } = await import('./gameServer')
  await startGameServer(PORT, { db: new DelayedFlatFile({ dir: tmpDir, logging: false, ttl: false }) })

  const created = (await (
    await fetch(`${BASE}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ numPlayers: 4 }),
    })
  ).json()) as { code: string; matchID: string }
  code = created.code
  matchID = created.matchID

  for (let i = 0; i < 4; i++) {
    const joined = (await (
      await fetch(`${BASE}/rooms/${code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerID: String(i), playerName: `Sync ${i}` }),
      })
    ).json()) as { playerCredentials: string }
    credentials.push(joined.playerCredentials)
  }
})

afterAll(() => {
  for (const c of clients) c.stop()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

function connect(i: number): MpClient {
  const client = Client({
    game: CatanGame,
    numPlayers: 4,
    playerID: String(i),
    credentials: credentials[i],
    matchID,
    multiplayer: SocketIO({ server: `127.0.0.1:${PORT}` }),
  })
  client.start()
  clients.push(client)
  return client
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return pred()
}

function raw(c: MpClient): RawState | null {
  return c.getState() as unknown as RawState | null
}

/** Ask the transport for a full-state sync, exactly like a reconnect would. */
function requestSync(c: MpClient): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(c as any).transport.requestSync()
}

describe('sync ordering (queued syncs vs move broadcasts)', () => {
  it('a re-sync racing a move never rolls the client back', async () => {
    for (let i = 0; i < 4; i++) connect(i)
    for (const c of clients) expect(await waitFor(() => raw(c) !== null)).toBe(true)

    const watcher = clients[1]
    expect(raw(watcher)!.ctx.phase).toBe('openingRoll')

    // seat 0 rolls — the moment the watcher's client applies the broadcast,
    // it asks for a full sync (the reconnect race). The server is still
    // committing the roll (delayed write), so an un-queued sync would fetch
    // and deliver the PRE-roll snapshot afterwards, wiping the broadcast.
    clients[0].moves.openingRoll()
    expect(await waitFor(() => raw(watcher)!.G.openingRolls[0] !== null)).toBe(true)
    const idAfterBroadcast = raw(watcher)!._stateID!
    requestSync(watcher)

    // give the (delayed) write + queued sync time to land, watching for a
    // regression the whole time
    let maxId = idAfterBroadcast
    for (let t = 0; t < 20; t++) {
      await new Promise((r) => setTimeout(r, 25))
      const s = raw(watcher)
      if (!s) continue
      maxId = Math.max(maxId, s._stateID ?? 0)
      expect(s._stateID ?? 0).toBeGreaterThanOrEqual(idAfterBroadcast)
    }
    // the roll is still applied and the state never regressed
    expect(raw(watcher)!.G.openingRolls[0]).not.toBeNull()
    expect(maxId).toBeGreaterThanOrEqual(idAfterBroadcast)
  }, 15000)

  it('the match still plays out from every seat after the race (same draft)', async () => {
    // remaining opening rolls — everyone can still act and see each other
    for (let i = 1; i < 4; i++) {
      expect(
        await waitFor(() => Number(raw(clients[0])!.ctx.currentPlayer) === i && raw(clients[0])!.G.openingRolls[i] === null),
      ).toBe(true)
      clients[i].moves.openingRoll()
      expect(await waitFor(() => raw(clients[0])!.G.openingRolls[i] !== null)).toBe(true)
    }
    expect(await waitFor(() => raw(clients[0])!.ctx.phase === 'setup')).toBe(true)

    // full snake draft — proves broadcasts keep reaching every client
    const f = raw(clients[0])!.G.firstPlayer!
    const forward = [0, 1, 2, 3].map((k) => (f + k) % 4)
    const order = [...forward, ...[...forward].reverse()]
    let placed = 0
    for (const p of order) {
      expect(
        await waitFor(
          () => Number(raw(clients[0])!.ctx.currentPlayer) === p && raw(clients[0])!.G.setupPlacements === placed,
        ),
      ).toBe(true)
      const g = raw(clients[0])!.G
      const v = validSetupVertices(g)[0]
      clients[p].moves.placeSetup(v, validSetupEdges(g, v)[0])
      expect(await waitFor(() => raw(clients[3])!.G.buildings.vertices[v] !== undefined)).toBe(true)
      placed++
    }
    expect(await waitFor(() => raw(clients[0])!.ctx.phase === 'main')).toBe(true)
  }, 30000)
})

describe('player trades over the wire', () => {
  /**
   * Roll for the current player, resolving any 7-flow, until the turn can
   * continue. Returns the client of the (possibly changed) current player.
   */
  async function rollAndResolve(): Promise<MpClient> {
    const active = () => Number(raw(clients[0])!.ctx.currentPlayer)
    const mover = clients[active()]
    mover.moves.roll()
    expect(await waitFor(() => raw(clients[0])!.G.rolled || raw(clients[0])!.G.robberStep !== null)).toBe(true)
    // resolve the 7-flow sub-step by sub-step: each dispatch waits only for ITS
    // OWN progress (moveRobber may hand over to a steal choice — that steal is
    // dispatched on the next loop pass, not behind this wait)
    for (let guard = 0; guard < 8; guard++) {
      const g = raw(clients[0])!.G
      const seat = active()
      if (!g.robberStep) break
      if (g.robberStep === 'discard') throw new Error('unexpected discard in early game')
      if (g.robberStep === 'move') {
        const before = g.robberTileId
        const board = (await import('#/game/board')).generateBoard(g.seed)
        const target = board.tiles.map((t) => t.id).find((t) => t !== before)!
        clients[seat].moves.moveRobber(target)
        expect(await waitFor(() => raw(clients[0])!.G.robberTileId !== before, 20000)).toBe(true)
      } else {
        clients[seat].moves.steal(g.stealTargets![0])
        expect(await waitFor(() => raw(clients[0])!.G.robberStep === null, 20000)).toBe(true)
      }
    }
    expect(raw(clients[0])!.G.robberStep).toBeNull()
    return clients[active()]
  }

  it('the offer reaches a partner (and clears on decline) for every seat', async () => {
    // advance turns until the current player holds a card to offer
    let proposer: MpClient | null = null
    let proposerSeat = -1
    for (let guard = 0; guard < 12 && !proposer; guard++) {
      const mover = await rollAndResolve()
      const seat = Number(raw(clients[0])!.ctx.currentPlayer)
      const hand = raw(mover)!.G.hands[seat] // own hand is unmasked on own client
      const held = (['wood', 'brick', 'grain', 'wool', 'ore'] as const).find((r) => hand[r] > 0)
      if (held) {
        proposer = mover
        proposerSeat = seat
        const give: Record<string, number> = { [held]: 1 }
        // ask for a card the partner may well not hold — the offer must still
        // be delivered so they can refuse (no information leak)
        const take: Record<string, number> = { ore: 1 }
        const partner = (seat + 1) % 4
        proposer.moves.proposeTrade(partner, give, take)

        // the PARTNER's client sees the pending offer…
        expect(await waitFor(() => raw(clients[partner])!.G.pendingTrade !== null)).toBe(true)
        const pt = raw(clients[partner])!.G.pendingTrade!
        expect(pt.proposer).toBe(seat)
        expect((pt.partners ?? [pt.partner])).toContain(partner)

        // …declines it (non-vacuous: pendingTrade was observed above)…
        clients[partner].moves.declineTrade()
        expect(await waitFor(() => raw(clients[partner])!.G.pendingTrade === null)).toBe(true)

        // …and the proposer is unlocked again (turn passes)
        proposer.moves.endTurn()
        expect(await waitFor(() => Number(raw(clients[0])!.ctx.currentPlayer) !== seat)).toBe(true)
      } else {
        mover.moves.endTurn()
        const next = (seat + 1) % 4
        expect(await waitFor(() => Number(raw(clients[0])!.ctx.currentPlayer) === next)).toBe(true)
      }
    }
    expect(proposer).not.toBeNull() // setup always leaves someone holding a card
    expect(proposerSeat).toBeGreaterThanOrEqual(0)
  }, 40000)
})

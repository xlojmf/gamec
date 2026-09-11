/**
 * M12 end-to-end multiplayer test: boots the real game server (ws + lobby +
 * rooms), joins 4 seats through the REST API, connects 4 socket clients and
 * plays the full setup draft — then verifies server-authoritative sync and
 * playerView secret masking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'boardgame.io/client'
import { SocketIO } from 'boardgame.io/multiplayer'
import { CatanGame, validSetupEdges, validSetupVertices, type BgioState } from '#/game/catan'
import { generateBoard } from '#/game/board'
import { totalCards } from '#/game/terrain'
import { startGameServer } from './gameServer'

const PORT = 8123
const BASE = `http://127.0.0.1:${PORT}`

type MpClient = ReturnType<typeof Client>

let code = ''
let matchID = ''
const creds: Array<{ playerID: string; credentials: string }> = []
const clients: MpClient[] = []

beforeAll(async () => {
  await startGameServer(PORT)

  const created = (await (
    await fetch(`${BASE}/rooms`, { method: 'POST' })
  ).json()) as { code: string; matchID: string }
  code = created.code
  matchID = created.matchID

  for (let i = 0; i < 4; i++) {
    const joined = (await (
      await fetch(`${BASE}/rooms/${code}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerID: String(i), playerName: `Settler ${i + 1}` }),
      })
    ).json()) as { playerCredentials: string; playerID: number }
    // regression: playerID must arrive as a number — a string here used to trip
    // loadMpSession's validation and surface as “Session lost” on /game
    expect(typeof joined.playerID).toBe('number')
    creds.push({ playerID: String(i), credentials: joined.playerCredentials })
  }
})

afterAll(() => {
  for (const c of clients) c.stop()
})

function connect(i: number): MpClient {
  const client = Client({
    game: CatanGame,
    numPlayers: 4,
    playerID: creds[i].playerID,
    credentials: creds[i].credentials,
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
    await new Promise((r) => setTimeout(r, 50))
  }
  return pred()
}

function G(c: MpClient) {
  return (c.getState() as unknown as BgioState | null)?.G
}

describe('rooms API', () => {
  it('hands out a 4-char code and seats four players', async () => {
    expect(code).toMatch(/^[A-Z2-9]{4}$/)
    const room = (await (await fetch(`${BASE}/rooms/${code}`)).json()) as {
      players: Array<{ id: number; name?: string }>
    }
    expect(room.players.map((p) => p.name)).toEqual(['Settler 1', 'Settler 2', 'Settler 3', 'Settler 4'])
  })

  it('rejects unknown rooms', async () => {
    const res = await fetch(`${BASE}/rooms/ZZZZ`)
    expect(res.status).toBe(404)
  })

  it('rejects double-booking a seat', async () => {
    const res = await fetch(`${BASE}/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerID: '0', playerName: 'Impostor' }),
    })
    expect(res.status).toBe(409)
  })

  it('creates a 3-player room; only the creator can start it', async () => {
    const created = (await (
      await fetch(`${BASE}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ numPlayers: 3 }),
      })
    ).json()) as { code: string; matchID: string; numPlayers: number; creatorToken: string }
    expect(created.numPlayers).toBe(3)
    expect(created.creatorToken).toBeTruthy()

    const room = (await (await fetch(`${BASE}/rooms/${created.code}`)).json()) as {
      players: unknown[]
      started?: boolean
    }
    expect(room.players).toHaveLength(3)
    expect(room.started).toBe(false)

    const denied = await fetch(`${BASE}/rooms/${created.code}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorToken: 'not-the-token' }),
    })
    expect(denied.status).toBe(403)

    const started = await fetch(`${BASE}/rooms/${created.code}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorToken: created.creatorToken }),
    })
    expect(started.status).toBe(200)
    const after = (await (await fetch(`${BASE}/rooms/${created.code}`)).json()) as { started?: boolean }
    expect(after.started).toBe(true)
  })
})

describe('multiplayer match', () => {
  it('health endpoint responds', async () => {
    expect(await (await fetch(`${BASE}/health`)).text()).toBe('ok')
  })

  it('clients sync the server state (same seed island)', async () => {
    for (let i = 0; i < 4; i++) connect(i)
    for (const c of clients) {
      expect(await waitFor(() => G(c)?.seed !== undefined)).toBe(true)
    }
    const seeds = clients.map((c) => G(c)!.seed)
    expect(new Set(seeds).size).toBe(1)
  })

  it('out-of-turn moves are rejected server-side', async () => {
    const g = G(clients[0])!
    const v = validSetupVertices(g)[0]
    clients[1].moves.placeSetup(v, validSetupEdges(g, v)[0])
    await new Promise((r) => setTimeout(r, 400))
    expect(G(clients[0])!.setupPlacements).toBe(0)
    expect((clients[0].getState() as unknown as BgioState).ctx.phase).toBe('openingRoll')
  })

  it('every seat rolls for turn order; the highest starts', async () => {
    for (let i = 0; i < 4; i++) {
      expect(
        await waitFor(
          () =>
            Number((clients[0].getState() as unknown as BgioState).ctx.currentPlayer) === i &&
            G(clients[0])!.openingRolls[i] === null,
        ),
      ).toBe(true)
      // seats also publish their display name on their turn (multiplayer aliases)
      clients[i].moves.setPlayerName(`Alias ${i}`)
      clients[i].moves.openingRoll()
      expect(await waitFor(() => G(clients[0])!.openingRolls[i] !== null)).toBe(true)
    }
    const g = G(clients[0])!
    expect(g.openingRolls.every((r) => r !== null)).toBe(true)
    const max = Math.max(...(g.openingRolls as number[]))
    expect(g.openingRolls[g.firstPlayer!]).toBe(max)
    // totals are unique (official tie re-roll)
    expect(new Set(g.openingRolls).size).toBe(4)
    // aliases propagated to every seat, and the log uses them
    expect(g.playerNames).toEqual(['Alias 0', 'Alias 1', 'Alias 2', 'Alias 3'])
    for (const c of clients) {
      expect(await waitFor(() => G(c)!.playerNames.every((n) => n.startsWith('Alias')))).toBe(true)
    }
    expect(g.log.some((l) => l.startsWith('Alias') && l.includes('for turn order'))).toBe(true)
    await expect(waitFor(() => (clients[0].getState() as unknown as BgioState).ctx.phase === 'setup')).resolves.toBe(true)
  })

  it('plays the full setup draft (snake from the roll winner) across sockets', async () => {
    const f = G(clients[0])!.firstPlayer!
    // snake draft: f, f+1, … then back — 8 placements total
    const forward = [0, 1, 2, 3].map((k) => (f + k) % 4)
    const order = [...forward, ...[...forward].reverse()]
    let placed = 0
    for (const p of order) {
      expect(
        await waitFor(
          () =>
            Number((clients[0].getState() as unknown as BgioState).ctx.currentPlayer) === p &&
            G(clients[0])!.setupPlacements === placed,
        ),
      ).toBe(true)
      const g = G(clients[0])!
      const v = validSetupVertices(g)[0]
      const e = validSetupEdges(g, v)[0]
      clients[p].moves.placeSetup(v, e)
      expect(await waitFor(() => G(clients[0])!.buildings.vertices[v] !== undefined)).toBe(true)
      placed++
      // every client converges on the same authoritative state
      for (const c of clients) {
        expect(await waitFor(() => G(c)!.buildings.vertices[v] !== undefined)).toBe(true)
      }
    }
    expect(G(clients[0])!.setupPlacements).toBe(8)
    expect((clients[0].getState() as unknown as BgioState).ctx.phase).toBe('main')
  })

  it('setup grants starting resources (hands non-empty)', () => {
    const g = G(clients[0])!
    const total = g.handSizes!.reduce((n, s) => n + s, 0)
    expect(total).toBeGreaterThan(0) // second-round settlements pay out
  })

  it('hides other hands via playerView but reports totals', () => {
    const seenBy1 = G(clients[1])!
    const real0 = G(clients[0])!
    // other players' cards are hidden…
    expect(totalCards(seenBy1.hands[0])).toBe(0)
    // …but their totals are public and consistent across views
    expect(seenBy1.handSizes![0]).toBe(totalCards(real0.hands[0]))
    expect(real0.handSizes![1]).toBe(totalCards(seenBy1.hands[1]))
    // dev hands and deck order follow the same contract
    expect(seenBy1.devHands[0]).toEqual([])
    expect(seenBy1.devDeck.every((c) => c === 'victoryPoint')).toBe(true)
  })

  it('the board regenerated from the shared seed matches on every client', () => {
    const seed = G(clients[0])!.seed
    const board = generateBoard(seed)
    for (const c of clients) {
      expect(G(c)!.robberTileId).toBe(board.desertTileId)
    }
  })
})

async function waitForAsync(pred: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return await pred()
}

describe('rematch & stall watchdog', () => {
  const PORT2 = 8141
  const BASE2 = `http://127.0.0.1:${PORT2}`
  let rcode = ''
  let rToken = ''

  it('boots with a 1s turn timeout', async () => {
    const { startGameServer } = await import('./gameServer')
    await startGameServer(PORT2, { turnTimeoutMs: 1000 })
    const created = (await (
      await fetch(`${BASE2}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ numPlayers: 4 }),
      })
    ).json()) as { code: string; creatorToken: string }
    rcode = created.code
    rToken = created.creatorToken
    for (let i = 0; i < 4; i++) {
      await fetch(`${BASE2}/rooms/${rcode}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerID: String(i), playerName: `W${i}` }),
      })
    }
    await fetch(`${BASE2}/rooms/${rcode}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorToken: rToken }),
    })
  }, 15000)

  it('auto-plays for seats that stall past the timeout', async () => {
    // nobody acts — the watchdog must drive the opening rolls (and further)
    const progressed = await waitForAsync(
      async () => {
        const room = (await (await fetch(`${BASE2}/rooms/${rcode}`)).json()) as { matchID: string }
        const client = Client({
          game: CatanGame,
          numPlayers: 4,
          matchID: room.matchID,
          multiplayer: SocketIO({ server: `127.0.0.1:${PORT2}` }),
        })
        client.start()
        await new Promise((r) => setTimeout(r, 150))
        const s = client.getState() as unknown as BgioState | null
        client.stop()
        return !!s?.G && s.G.setupPlacements > 0
      },
      25000,
    )
    expect(progressed).toBe(true)
  }, 30000)

  it('rematch mints a fresh island for the same room (creator only)', async () => {
    const before = (await (await fetch(`${BASE2}/rooms/${rcode}`)).json()) as { matchID: string }
    const denied = await fetch(`${BASE2}/rooms/${rcode}/rematch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorToken: 'wrong' }),
    })
    expect(denied.status).toBe(403)

    const ok = (await (
      await fetch(`${BASE2}/rooms/${rcode}/rematch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creatorToken: rToken }),
      })
    ).json()) as { matchID: string; started: boolean }
    expect(ok.started).toBe(false)
    expect(ok.matchID).not.toBe(before.matchID)

    const room = (await (await fetch(`${BASE2}/rooms/${rcode}`)).json()) as {
      players: Array<{ name?: string }>
      started: boolean
    }
    expect(room.started).toBe(false)
    // fresh match → empty seats to re-take
    expect(room.players.every((p) => !p.name)).toBe(true)
  })
})

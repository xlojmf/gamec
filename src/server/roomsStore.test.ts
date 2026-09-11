/**
 * Persistence + stall-handling + rematch tests (rooms store round-trip and
 * the watchdog auto-play through real sockets).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomsStore } from './roomsStore'

describe('RoomsStore (file persistence)', () => {
  const dirs: string[] = []

  function tmpFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'catan-rooms-'))
    dirs.push(dir)
    return join(dir, 'rooms.json')
  }

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  it('round-trips rooms across store instances', () => {
    const file = tmpFile()
    const a = new RoomsStore(file)
    a.set('ABCD', {
      matchID: 'm1',
      numPlayers: 3,
      started: true,
      creatorToken: 'tok',
      seatNames: { '0': 'Alice' },
      seatCredentials: { '0': 'cred-0' },
      updatedAt: '',
    })

    const b = new RoomsStore(file)
    expect(b.get('ABCD')).toMatchObject({ matchID: 'm1', numPlayers: 3, started: true, creatorToken: 'tok' })
    expect(b.get('ABCD')!.seatNames['0']).toBe('Alice')
    expect(b.get('ABCD')!.seatCredentials['0']).toBe('cred-0')
  })

  it('survives a partially-written file (tmp+rename never yields this, but be safe)', () => {
    const file = tmpFile()
    writeFileSync(file, '{ not json')
    const store = new RoomsStore(file)
    expect(store.has('ABCD')).toBe(false)
    store.set('WXYZ', {
      matchID: 'm2',
      numPlayers: 4,
      started: false,
      creatorToken: 't',
      seatNames: {},
      seatCredentials: {},
      updatedAt: '',
    })
    expect(JSON.parse(readFileSync(file, 'utf8')).WXYZ.matchID).toBe('m2')
  })

  it('no path configured → memory only', () => {
    const store = new RoomsStore(null)
    store.set('TEST', {
      matchID: 'x',
      numPlayers: 4,
      started: false,
      creatorToken: 't',
      seatNames: {},
      seatCredentials: {},
      updatedAt: '',
    })
    expect(store.entries()).toHaveLength(1)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { staleSyncGuard } from './transport'

/** Minimal stand-in for a bgio transport instance: records delivered data. */
function fakeTransport() {
  const delivered: Array<{ type: string; args: unknown[] }> = []
  return {
    delivered,
    notifyClient: (data: { type: string; args: unknown[] }) => {
      delivered.push(data)
    },
  }
}

const update = (id: number) => ({ type: 'update', args: ['m1', { _stateID: id }, []] })
const sync = (id: number) => ({ type: 'sync', args: ['m1', { state: { _stateID: id } }] })
const patch = (id: number) => ({ type: 'patch', args: ['m1', id - 1, id, [], []] })

describe('staleSyncGuard', () => {
  it('drops a sync older than an already-delivered update (the trade-freeze race)', () => {
    const t = fakeTransport()
    const wrapped = staleSyncGuard(() => t)
    const transport = wrapped({})

    transport.notifyClient(update(5))
    expect(t.delivered).toHaveLength(1)

    // the stale full-state snapshot arrives AFTER the newer broadcast —
    // bgio 0.50 would apply it unconditionally and roll the client back
    transport.notifyClient(sync(4))
    expect(t.delivered).toHaveLength(1)
  })

  it('lets fresh and equal-version syncs through (reconnects must still work)', () => {
    const t = fakeTransport()
    const transport = staleSyncGuard(() => t)({})

    transport.notifyClient(update(5))
    transport.notifyClient(sync(5)) // same revision, e.g. reconnect with no moves since
    transport.notifyClient(sync(9)) // server moved ahead while we were away
    expect(t.delivered.map((d) => d.type)).toEqual(['update', 'sync', 'sync'])
  })

  it('never drops the first sync on a cold client', () => {
    const t = fakeTransport()
    const transport = staleSyncGuard(() => t)({})
    transport.notifyClient(sync(0))
    expect(t.delivered).toHaveLength(1)
  })

  it('tracks patch message IDs too, and passes non-state messages through', () => {
    const t = fakeTransport()
    const transport = staleSyncGuard(() => t)({})

    transport.notifyClient(patch(7))
    transport.notifyClient(sync(6)) // older than the patch → stale
    transport.notifyClient({ type: 'matchData', args: ['m1', []] })
    expect(t.delivered.map((d) => d.type)).toEqual(['patch', 'matchData'])
  })

  it('does not touch other transport behaviour (factory is called once)', () => {
    const inner = vi.fn(() => fakeTransport())
    const transport = staleSyncGuard(inner)({ matchID: 'm1' })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(transport).toBeDefined()
  })
})

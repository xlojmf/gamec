/**
 * Stale-sync guard for boardgame.io 0.50 multiplayer transports.
 *
 * bgio 0.50's client applies full-state `sync` responses UNCONDITIONALLY —
 * unlike the `update` handler there is no stateID guard. A sync response that
 * raced a move broadcast (the server fetched state before a concurrent move
 * was persisted, and sent it after that move's broadcast) therefore ROLLS the
 * client back: a pending trade offer vanishes from the responder's screen and,
 * worse, the regressed stateID makes every subsequent move from this client
 * fail the server's "invalid stateID" check — the player is silently locked
 * out until a manual page refresh. Wrap the multiplayer factory with this
 * guard to drop sync payloads older than anything the transport already saw.
 */

type TransportData = { type: string; args: unknown[] }

/** Anything the multiplayer factory contract needs (kept loose on purpose). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransportFactory = (opts: any) => any

/** The newest _stateID carried by a transport message (-1 when absent). */
function messageId(data: TransportData): number {
  if (data.type === 'update') {
    // [matchID, state, deltalog]
    return (data.args[1] as { _stateID?: number } | undefined)?._stateID ?? -1
  }
  if (data.type === 'sync') {
    // [matchID, { state, log, filteredMetadata, initialState }]
    return ((data.args[1] as { state?: { _stateID?: number } } | undefined)?.state)?._stateID ?? -1
  }
  if (data.type === 'patch') {
    // [matchID, prevStateID, stateID, patch, deltalog]
    return typeof data.args[2] === 'number' ? data.args[2] : -1
  }
  return -1
}

/**
 * Wrap a bgio multiplayer transport factory (e.g. `SocketIO({ server })`) so
 * stale full-state syncs are dropped before they reach the client's store.
 * Fresh syncs, updates, patches and metadata/chat messages pass through
 * untouched; a sync is only dropped when the transport has already delivered
 * a strictly newer state version.
 */
export function staleSyncGuard(factory: TransportFactory): TransportFactory {
  return (transportOpts) => {
    const transport = factory(transportOpts)
    const deliver = transport.notifyClient.bind(transport)
    let lastSeen = -1
    transport.notifyClient = (data: TransportData) => {
      const id = messageId(data)
      if (id > lastSeen) lastSeen = id
      if (data.type === 'sync' && id >= 0 && id < lastSeen) return // stale — keep the newer state
      deliver(data)
    }
    return transport
  }
}

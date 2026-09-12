/**
 * Persistent store for the rooms registry (code → room), PRD §7 stretch goal.
 *
 * A tiny JSON-file store: loaded once on boot, saved (atomic tmp+rename) after
 * every mutation. The bgio match state itself is persisted separately by
 * boardgame.io's FlatFile adapter (FLATFILE_DIR) — this file only maps room
 * codes to matchIDs plus the creator token / started flag / seat names.
 *
 * No path configured (dev/tests) → everything stays in memory.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface StoredRoom {
  matchID: string
  numPlayers: number
  /** Fixed map preset id for the room's matches (null = random island). */
  mapPreset?: string | null
  started: boolean
  creatorToken: string
  /** seat names captured at join (used by the rematch flow) */
  seatNames: Record<string, string>
  /** seat credentials issued by the bgio lobby (used by the stall watchdog) */
  seatCredentials: Record<string, string>
  /** ISO timestamp of the last state change (informational) */
  updatedAt: string
}

export class RoomsStore {
  private rooms = new Map<string, StoredRoom>()
  private file: string | null

  constructor(file: string | null) {
    this.file = file
    if (file) {
      try {
        const raw = readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, StoredRoom>
        for (const [code, room] of Object.entries(parsed)) this.rooms.set(code, room)
        console.log(`[rooms] restored ${this.rooms.size} room(s) from ${file}`)
      } catch {
        console.log(`[rooms] no existing store at ${file} — starting fresh`)
      }
    }
  }

  get(code: string): StoredRoom | undefined {
    return this.rooms.get(code)
  }

  has(code: string): boolean {
    return this.rooms.has(code)
  }

  set(code: string, room: StoredRoom): void {
    room.updatedAt = new Date().toISOString()
    this.rooms.set(code, room)
    this.save()
  }

  delete(code: string): void {
    this.rooms.delete(code)
    this.save()
  }

  entries(): Array<[string, StoredRoom]> {
    return [...this.rooms.entries()]
  }

  private save(): void {
    if (!this.file) return
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.rooms), null, 2))
    renameSync(tmp, this.file)
  }
}

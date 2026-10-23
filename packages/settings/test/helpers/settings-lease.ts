import { vi } from "vitest"
import type { FsWatchService, WatchLease, WatchNotification, WatchCursor } from "@i-harness/fs-watch"
export function controlledLease() {
  let resolveReady!: (cursor: WatchCursor) => void, rejectReady!: (error: unknown) => void
  const listeners = new Set<(event: WatchNotification) => void>()
  const ready = new Promise<WatchCursor>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const lease: WatchLease = { ready, subscribe: vi.fn(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }), close: vi.fn(async () => {}) }
  const service: FsWatchService = { acquire: vi.fn(() => lease), close: vi.fn(async () => {}) }
  const cursor = { epoch: 1, revision: 0 }
  return { lease, service, cursor, rejectReady, emit(event: WatchNotification) { for (const cb of listeners) cb(event) },
    ready() { resolveReady(cursor) }, reset(reason: "initial" | "recovered" | "overflow" | "subscribe" = "initial") { this.emit({ kind: "reset", reason, cursor }); this.ready() },
    changed(...paths: string[]) { this.emit({ kind: "changed", cursor, changes: paths.map(path => ({ path, kind: "change" })) }) } }
}

export const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)) }

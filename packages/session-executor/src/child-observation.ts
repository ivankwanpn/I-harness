import { subscribe, type SessionView as Session } from "@i-harness/core-session"
import type { AgentTable, ChildAgentEntry } from "@i-harness/subagent"

/** Process-local observation only. Durable storage remains owned by the child. */
export function createChildObservation(table: AgentTable) {
  type Change = { kind: "changed" | "closed" }
  const listeners = new Set<(change: Change) => void>()
  const rows = new Map<string, { entry: ChildAgentEntry; session: Session; sessionId: string; off: () => void }>()
  let closed = false
  function notify(kind: Change["kind"]) {
    for (const listener of [...listeners]) {
      try { listener({ kind }) } catch { /* UI observers must never interrupt child execution. */ }
    }
  }
  function current(path: string, row: NonNullable<ReturnType<typeof rows.get>>) {
    return !closed && table.get(path) === row.entry && row.entry.session === row.session && row.entry.sessionId === row.sessionId
  }
  function reconcile(path: string) {
    if (closed) return
    const previous = rows.get(path), entry = table.get(path)
    if (previous && current(path, previous)) return
    previous?.off(); rows.delete(path)
    if (!entry?.sessionId) return
    const row = { entry, session: entry.session, sessionId: entry.sessionId, off: () => {} }
    row.off = subscribe(row.session, event => {
      if (event.seq !== undefined && current(path, row)) notify("changed")
    })
    rows.set(path, row)
  }
  // Table subscription precedes the snapshot so additions during setup cannot be lost.
  const offTable = table.subscribe(change => { reconcile(change.path); if (!closed) notify("changed") })
  for (const path of table.entries().keys()) reconcile(path)
  return {
    liveSession(id: string): Session | undefined {
      for (const [path, row] of rows) if (row.sessionId === id && current(path, row)) return row.session
      return undefined
    },
    subscribe(listener: (change: Change) => void): () => void {
      if (!closed) listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (closed) return
      closed = true
      offTable()
      for (const row of rows.values()) row.off()
      rows.clear()
      notify("closed"); listeners.clear()
    },
  }
}

import { createSession } from "@i-harness/core-session"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"

export type ChildStatus = "running" | "waiting" | "completed" | "killed" | "error"
export interface ChildAgentEntry {
  path: string
  status: ChildStatus
  session: ReturnType<typeof createSession>
  controller: AbortController
  finalText?: string
  error?: string
  mailbox: string[]
  jobId?: string
  unmount?: () => void
  /** Drains the child's runtime and turn producers before its owner closes storage. */
  dispose?: () => Promise<void>
  /** Cancel current cells and join their producers while retaining the runtime. */
  cancel?: (reason?: string) => Promise<void>
  /** Process-local admission barrier while runtime/turn producers drain. */
  closing?: boolean
  sessionId?: string
  roleName?: string
  /** Runtime-only owning registry identity; never included in durable or UI snapshots. */
  toolRegistry?: ToolRegistry
  /** Exact child-local wrapper bindings produced by the existing host factory. */
  factoryTools?: readonly Tool[]
  /** W11: the epoch ms at which this entry's CURRENT run began — the fact that
   * makes "how long has this child been running" answerable. Stamped where a
   * run starts and NOWHERE else: `spawnChild` (the initial run) and
   * `driveFollowups` (every re-drive) — the only two sites in this package
   * that write `status = "running"`.
   *
   * It is NOT the entry's age, and that is deliberate: a child woken a second
   * ago must not read as one that has been running for twenty minutes — the
   * whole point of the number is that the main agent can trust it.
   *
   * (The job registry's `JobSnapshot.startedAt` is the OTHER clock — when the
   * job was created, never re-stamped — and the two disagree after any
   * followup. Read this one through `runningElapsedMs`, which is the single
   * place the elapsed rule is written.)
   *
   * Optional because it is additive: entries rebuilt from a restored snapshot
   * (`restoreState`) never come back `running` (a process that died mid-run is
   * restored as `error`), so an unstamped entry has nothing to measure and
   * every reader must say so rather than guess. */
  startedAt?: number
  /** WHY: child.ts:340 records the spawn model as `provider:model`, but
   * persist.ts:136 also restores older entries without a label; absence is not
   * proof of inheritance. Keep this spawn fact rather than re-deriving it from
   * today's settings, which can change under a running child. */
  modelLabel?: string
  followupChain?: Promise<void>
  lastInboxSeq?: number
}
export interface AgentTable {
  /** Direct external entry mutation is retained for compatibility but emits no lifecycle event. */
  entries(): Map<string, ChildAgentEntry>
  add(path: string, entry: ChildAgentEntry): void
  get(path: string): ChildAgentEntry | undefined
  remove(path: string): void
  update(path: string, expected: ChildAgentEntry, patch: Partial<Omit<ChildAgentEntry, "path">>): boolean
  subscribe(listener: (change: AgentTableChange) => void): () => void
}
export interface AgentTableChange {
  kind: "add" | "update" | "remove"
  path: string
  entry: ChildAgentEntry
}
export function createAgentTable(): AgentTable {
  const table = new Map<string, ChildAgentEntry>()
  const listeners = new Set<(change: AgentTableChange) => void>()
  const publish = (change: AgentTableChange) => {
    for (const listener of [...listeners]) { try { listener(change) } catch { /* Observers never interrupt producers. */ } }
  }
  return {
    entries: () => table,
    add: (path, entry) => { table.set(path, entry); publish({ kind: "add", path, entry }) },
    get: (path) => table.get(path),
    remove: (path) => {
      const entry = table.get(path)
      if (entry) { table.delete(path); publish({ kind: "remove", path, entry }) }
    },
    update(path, expected, patch) {
      if (table.get(path) !== expected) return false
      Object.assign(expected, patch)
      publish({ kind: "update", path, entry: expected })
      return true
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/** W11: how long the entry's CURRENT run has been going — `undefined` when
 * there is nothing to measure, which is its own answer (the entry is not
 * running, or it carries no start stamp) and must not be flattened into 0.
 *
 * This is the ONE place the elapsed rule is written, deliberately: the asked
 * path (`list_agents`' `elapsed_ms`) and the unasked one (the `subagents`
 * runtime-context section's threshold test) read the same function, so the
 * section can never list a child whose own row reports a smaller number.
 *
 * `Math.max(0, …)`: a backward wall-clock step (NTP) would otherwise render a
 * negative "running for", which is not an answer to the question asked. */
export function runningElapsedMs(entry: ChildAgentEntry, now: number = Date.now()): number | undefined {
  if (entry.status !== "running" || entry.startedAt === undefined) return undefined
  return Math.max(0, now - entry.startedAt)
}

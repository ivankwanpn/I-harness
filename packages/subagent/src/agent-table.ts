import { createSession } from "@i-harness/core-session"

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
  sessionId?: string
  roleName?: string
  /** The model this child actually ran on, as `provider:model`, RECORDED at
   * spawn. Absent = it inherited the parent's client. Never re-derived at read
   * time: a running child's settings can change under it, and the row must say
   * what IS, not what today's configuration would say. */
  modelLabel?: string
  followupChain?: Promise<void>
  lastInboxSeq?: number
}
export interface AgentTable {
  entries(): Map<string, ChildAgentEntry>
  add(path: string, entry: ChildAgentEntry): void
  get(path: string): ChildAgentEntry | undefined
  remove(path: string): void
}
export function createAgentTable(): AgentTable {
  const table = new Map<string, ChildAgentEntry>()
  return {
    entries: () => table,
    add: (path, entry) => { table.set(path, entry) },
    get: (path) => table.get(path),
    remove: (path) => { table.delete(path) },
  }
}

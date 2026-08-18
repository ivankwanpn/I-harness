import { createSession } from "@i-harness/core-session"

export type ChildStatus = "running" | "completed" | "killed" | "error"
export interface ChildAgentEntry {
  path: string
  status: ChildStatus
  session: ReturnType<typeof createSession>
  controller: AbortController
  finalText?: string
  error?: string
  mailbox: string[]
  jobId?: string
  sessionId?: string
  unmount?: () => void
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

import type { McpServerState, SupervisorDeps } from "./types.ts"

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Owns lifecycle status and the terminal closed guard. Callbacks stay lazy. */
export function createSupervisorStatus(serverName: string, deps: Pick<SupervisorDeps, "onStatus">) {
  let state: McpServerState = "connecting"
  let closed = false
  let attempts = 0
  let lastError: string | undefined

  const emitStatus = (next: McpServerState, attemptCount?: number, err?: string): void => {
    if (closed) return
    deps.onStatus?.({
      server: serverName,
      state: next,
      ...(attemptCount !== undefined ? { attempts: attemptCount } : {}),
      ...(err !== undefined ? { lastError: err } : {}),
    })
  }

  return {
    state: () => state,
    setState: (next: McpServerState): void => { state = next },
    isClosed: () => closed,
    markClosed: (): void => { closed = true },
    attempts: () => attempts,
    setAttempts: (next: number): void => { attempts = next },
    lastError: () => lastError,
    recordError: (err: unknown): void => { lastError = errText(err) },
    emitStatus,
  }
}

export type SupervisorStatus = ReturnType<typeof createSupervisorStatus>

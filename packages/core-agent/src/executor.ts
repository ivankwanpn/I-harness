import { randomUUID } from "node:crypto"
import type { Session } from "@i-harness/core-session"
import { Inbox, type AdmittedInput, type PendingInput } from "@i-harness/core-session"
import type { AgentResult } from "./index.ts"

export type InputSubmit =
  /** `signal` (M41b): the per-turn abort — the pump forwards it to
   * agent.run so an in-flight turn can be cancelled at step boundaries /
   * stream yields (not just the queued gate). */
  | { tier: "send"; text: string; signal?: AbortSignal }
  | { tier: "followup"; text: string; signal?: AbortSignal }
  | { tier: "steer"; text: string; signal?: AbortSignal }
  | { tier: "inject"; text: string; description: string; scope: "turn" | "session" }

export interface AgentRunSurface {
  run(task: string, signal?: AbortSignal): Promise<AgentResult>
}

export interface SessionExecutorDeps {
  session: Session
  agent: AgentRunSurface
  inbox: Inbox
  signal?: AbortSignal
}

export interface SessionExecutor {
  submit(input: InputSubmit): { inputId: string }
  cancel(inputId: string): { cancelled: boolean }
  pending(): PendingInput[]
  isRunning(): boolean
  drain(): Promise<void>
  dispose(): void
}

// R-A1 four-tier → durable admission mapping. The durable ladder has no "wake"
// field (opencode Delivery = "steer" | "queue" only); the executor is
// event-driven, so ANY admission while idle starts the idle drain and a queue
// admission while a turn is active waits for the next turn boundary.
export function mapSubmitToAdmission(input: InputSubmit): AdmittedInput {
  switch (input.tier) {
    case "send":
    case "followup":
      return { inputId: randomUUID(), text: input.text, delivery: "queue", intent: "user" }
    case "steer":
      return { inputId: randomUUID(), text: input.text, delivery: "steer", intent: "user" }
    case "inject":
      return {
        inputId: randomUUID(),
        text: input.text,
        delivery: input.scope === "turn" ? "steer" : "queue",
        intent: "system",
        synthetic: { description: input.description, scope: input.scope },
      }
  }
}

// R-A2: the per-session serial lane. Per-session serial: every submit appends
// a pump onto ONE promise chain (driveFollowups precedent) — one turn at a time
// per executor, no two turns on the same session ever overlap. Cross-session
// parallel: nothing is shared between executors; the registry (below) is a
// plain map, so N sessions run concurrently in one process. Each pump drains
// the pending FIFO to empty, so a submission arriving mid-turn is picked up
// either by the running pump's next loop iteration (queue tier, after the
// current turn) or by the step-boundary seam (steer tier, Task 3).
export function createSessionExecutor(deps: SessionExecutorDeps): SessionExecutor {
  let chain: Promise<void> = Promise.resolve()
  let running = false
  let disposed = false
  // Serial-lane error surface: a rejected turn must not permanently break the
  // lane (hardening, driveFollowups precedent) — but the failure DOES need to
  // reach the last drain() caller, otherwise hosts (CLI exitCode) silently
  // report success on a failed turn. Captured; thrown by drain(); cleared when
  // a later turn succeeds.
  let lastError: unknown
  // M41b: per-submit signals ride in by inputId (the FIFO may hold several).
  const turnSignals = new Map<string, AbortSignal>()

  function pump(): Promise<void> {
    chain = chain.then(async () => {
      for (;;) {
        if (disposed || (deps.signal?.aborted ?? false)) return
        const next = deps.inbox.pending()[0]
        if (next === undefined) return
        running = true
        try {
          deps.inbox.promote(next.inputId)
          // turn/start + user/message are appended BY the agent loop here
          // (agent.run), so the promoted marker immediately precedes them.
          const sig = turnSignals.get(next.inputId) ?? deps.signal
          turnSignals.delete(next.inputId)
          await deps.agent.run(next.text, sig)
          lastError = undefined
        } catch (err) {
          lastError = err
          return // a failed turn stops this pump (its remaining pending stay
          // for a future pump); the error surfaces through drain()
        } finally {
          running = false
        }
      }
    }).catch(() => {
      // Hardening: an unexpected pump rejection must never unwrap the lane
      // chain itself (new submissions pump again from the current set).
    })
    return chain
  }

  return {
    submit(input: InputSubmit) {
      const admission = mapSubmitToAdmission(input)
      deps.inbox.admit(admission)
      const signal = (input as InputSubmit & { signal?: AbortSignal }).signal
      if (signal !== undefined) turnSignals.set(admission.inputId, signal)
      void pump()
      return { inputId: admission.inputId }
    },
    cancel(inputId) {
      const cancelled = deps.inbox.cancel(inputId)
      return { cancelled }
    },
    pending: () => deps.inbox.pending(),
    isRunning: () => running,
    drain: () => chain.then(() => {
      if (lastError !== undefined) throw lastError
    }),
    dispose() {
      disposed = true
    },
  }
}

export interface SessionExecutorRegistry {
  register(sessionId: string, executor: SessionExecutor): void
  get(sessionId: string): SessionExecutor | undefined
  remove(sessionId: string): void
  entries(): Map<string, SessionExecutor>
}

export function createSessionExecutorRegistry(): SessionExecutorRegistry {
  const executors = new Map<string, SessionExecutor>()
  return {
    register: (sessionId, executor) => {
      if (executors.has(sessionId)) throw new Error(`duplicate session executor: ${sessionId}`)
      executors.set(sessionId, executor)
    },
    get: (sessionId) => executors.get(sessionId),
    remove: (sessionId) => { executors.delete(sessionId) },
    entries: () => executors,
  }
}

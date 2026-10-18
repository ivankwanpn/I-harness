import { randomUUID } from "node:crypto"
import type { ImageInput, SessionView as Session } from "@i-harness/core-session"
import { Inbox, AsyncInbox, type AdmittedInput, type PendingInput } from "@i-harness/core-session"
import type { AgentResult } from "./index.ts"
import type { AgentInputOptions } from "./agent/types.ts"

export type InputSubmit = (
  /** `signal` (M41b): the per-turn abort — the pump forwards it to
   * agent.run so an in-flight turn can be cancelled at step boundaries /
   * stream yields (not just the queued gate). */
  | { tier: "send"; text: string; signal?: AbortSignal; images?: ImageInput[]; clientToken?: string }
  | { tier: "followup"; text: string; signal?: AbortSignal; images?: ImageInput[]; clientToken?: string }
  | { tier: "steer"; text: string; signal?: AbortSignal; images?: ImageInput[]; clientToken?: string }
  | { tier: "inject"; text: string; description: string; scope: "turn" | "session" }
) & { provenance?: import("@i-harness/core-session").InputProvenance }

export interface AgentRunSurface {
  runAdmitted?: AgentRunSurface['run']
  run(task: string, signal?: AbortSignal, images?: ImageInput[], inputId?: string, options?: AgentInputOptions): Promise<AgentResult>
}

export interface SessionExecutorDeps {
  session: Session
  agent: AgentRunSurface
  inbox: Inbox | AsyncInbox
  signal?: AbortSignal
}

export interface SessionExecutorFailure extends Error {
  /** Pending inputs at the failed turn's boundary; excludes the promoted input.
   * A snapshot, not a live queue count (the lane clears its saved failure on success). */
  readonly pendingCount: number
}

// WHY: service submit already forwards this rejection to its host
// (packages/session-executor/src/service.ts:828-836). Non-enumerable metadata
// makes the pause visible in-process without changing serialized error shapes
// or writable Error identity/classification. Frozen/non-Error throws retain
// their original value as cause instead of losing the pending count.
function withPendingCount(error: unknown, pendingCount: number): SessionExecutorFailure {
  if (error instanceof Error) {
    try {
      Object.defineProperty(error, "pendingCount", { value: pendingCount, configurable: true })
      return error as SessionExecutorFailure
    } catch {
      // A frozen provider error cannot carry metadata; preserve it as cause.
    }
  }
  const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error })
  if (error instanceof Error) failure.name = error.name
  Object.defineProperty(failure, "pendingCount", { value: pendingCount, configurable: true })
  return failure as SessionExecutorFailure
}

export interface SessionExecutor {
  /** Submit one input onto the serial lane. `inputId` (OPTIONAL, M49 Task 11)
   * lets a caller (session-executor service) retain its service row id
   * THROUGH the lane admission so a queue projection can merge service-front
   * and lane rows by the same public id and cancel by it. Absent → a fresh id
   * is generated (pre-M49 behavior). */
  submit(input: InputSubmit, inputId?: string): { inputId: string; admitted: Promise<void> }
  /** Execute exactly one durable pending input; no duplicate admission. */
  runAdmitted(inputId: string, signal?: AbortSignal, options?: Pick<AgentInputOptions, 'generation' | 'preparation' | 'delegatedOrigin'>): Promise<void>
  cancel(inputId: string): Promise<{ cancelled: boolean }>
  cancelCurrent?(): { cancelled: boolean }
  pending(): PendingInput[]
  isRunning(): boolean
  /** M49 Task 11: the input the lane is currently executing (promoted, not yet
   * finished) — undefined when idle. The queue projection's single "running"
   * row, with the honest text/delivery/intent (a lane-only steer that just
   * left pending is still representable). */
  currentInput(): PendingInput | undefined
  drain(): Promise<void>
  dispose(): void
}

// R-A1 four-tier → durable admission mapping.
// Authoritative delivery / wake contract: docs/concurrency-and-wake.md (§1–2).
// This helper constructs an admission; submit() below owns the push.
// Keep cross-tier/idle/boundary semantics in that document.
export function mapSubmitToAdmission(input: InputSubmit): AdmittedInput {
  const provenance = input.provenance ?? { kind: "unknown" as const, authority: "unknown" as const, scope: "turn" as const, producer: "agent.input" }
  switch (input.tier) {
    case "send":
    case "followup":
      return { inputId: randomUUID(), text: input.text, provenance, delivery: "queue", intent: "user", ...(input.images?.length ? { images: input.images } : {}), ...(input.clientToken ? { clientToken: input.clientToken } : {}) }
    case "steer":
      return { inputId: randomUUID(), text: input.text, provenance, delivery: "steer", intent: "user", ...(input.images?.length ? { images: input.images } : {}), ...(input.clientToken ? { clientToken: input.clientToken } : {}) }
    case "inject":
      return {
        inputId: randomUUID(),
        text: input.text,
        provenance,
        delivery: input.scope === "turn" ? "steer" : "queue",
        intent: "system",
        synthetic: { description: input.description, scope: input.scope },
      }
  }
}

// R-A2: the per-executor serial lane (promise chain below).
// Authoritative concurrency, wake and failure semantics:
// docs/concurrency-and-wake.md (§2–3).
// Hosts register one executor per session; the registry rejects duplicate
// registrations but cannot police ad-hoc duplicate executors.
// Local implementation: append drain work to chain, not a background re-pump.
// Observer/error reporting does not change this lane's restart policy;
// consult the contract before altering it.
export function createSessionExecutor(deps: SessionExecutorDeps): SessionExecutor {
  let chain: Promise<void> = Promise.resolve()
  let running = false
  let current: PendingInput | undefined
  let currentAbort: AbortController | undefined
  let disposed = false
  // Serial-lane error surface: a rejected turn must not permanently break the
  // lane (hardening, driveFollowups precedent) — but the failure DOES need to
  // reach the last drain() caller, otherwise hosts (CLI exitCode) silently
  // report success on a failed turn. Captured; thrown by drain(); cleared when
  // a later turn succeeds.
  let lastError: SessionExecutorFailure | undefined
  // M41b: per-submit signals ride in by inputId (the FIFO may hold several).
  const turnSignals = new Map<string, AbortSignal>()
  const turnOptions = new Map<string, Pick<AgentInputOptions, 'generation' | 'preparation' | 'delegatedOrigin'>>()
  const admissions = new Map<string, { admitted: Promise<void>; controller: AbortController }>()

  function pump(onlyId?: string): Promise<void> {
    chain = chain.then(async () => {
      for (;;) {
        if (disposed || (deps.signal?.aborted ?? false)) return
        const next = onlyId === undefined ? deps.inbox.pending()[0] : deps.inbox.pending().find((input) => input.inputId === onlyId)
        if (next === undefined) return
        const inputSignal = turnSignals.get(next.inputId)
        const sig = inputSignal && deps.signal ? AbortSignal.any([inputSignal, deps.signal]) : inputSignal ?? deps.signal
        if (sig?.aborted) {
          turnSignals.delete(next.inputId)
          if (onlyId !== undefined) return // durable input remains available for explicit resume
          await deps.inbox.cancel(next.inputId, "aborted")
          continue
        }
        running = true
        current = next
        try {
          if (!deps.agent.runAdmitted) {
            if (!(deps.inbox instanceof Inbox)) throw Object.assign(new Error('Managed Agent must own atomic input-start'), { code: 'FACT_OWNER_UNSUPPORTED' })
            deps.inbox.promote(next.inputId)
          }
          // turn/start + user/message are appended BY the agent loop here
          // (agent.run), so the promoted marker immediately precedes them.
          turnSignals.delete(next.inputId)
          currentAbort = new AbortController()
          const run = deps.agent.runAdmitted ?? deps.agent.run
          const prepared = turnOptions.get(next.inputId)
          turnOptions.delete(next.inputId)
          await run.call(deps.agent, next.text, sig ? AbortSignal.any([sig, currentAbort.signal]) : currentAbort.signal, next.images, next.inputId, next.provenance ? { provenance: next.provenance, ...prepared } : undefined)
          lastError = undefined
        } catch (err) {
          lastError = withPendingCount(err, deps.inbox.pending().length)
          return // a failed turn stops this pump (its remaining pending stay
          // for a future pump); the error surfaces through drain()
        } finally {
          running = false
          current = undefined
          currentAbort = undefined
        }
        if (onlyId !== undefined) return
      }
    }).catch(() => {
      // Hardening: an unexpected pump rejection must never unwrap the lane
      // chain itself (new submissions pump again from the current set).
    })
    return chain
  }

  return {
    runAdmitted(inputId, signal, options) {
      if (disposed) return Promise.reject(new Error("session executor disposed"))
      if (!deps.inbox.isPending(inputId)) return Promise.reject(new Error("Input is no longer pending"))
      if (signal) turnSignals.set(inputId, signal)
      if (options) turnOptions.set(inputId, options)
      return pump(inputId).then(() => { if (lastError !== undefined) throw lastError })
    },
    submit(input: InputSubmit, inputId?: string) {
      const admission = mapSubmitToAdmission(input)
      // Task 11: the caller-supplied public id is retained THROUGH the lane so
      // the service queue projection merges by one id (inbox.admit fails
      // closed on duplicates — a memory is ground truth, never overwritten).
      if (inputId !== undefined) admission.inputId = inputId
      const signal = (input as InputSubmit & { signal?: AbortSignal }).signal
      const controller = new AbortController()
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      turnSignals.set(admission.inputId, combined)
      const admitted = Promise.resolve(deps.inbox instanceof AsyncInbox ? deps.inbox.admit(admission, combined) : deps.inbox.admit(admission)).then(() => { void pump() })
      admissions.set(admission.inputId, { admitted, controller })
      void admitted.then(() => { admissions.delete(admission.inputId) }, error => { lastError = withPendingCount(error, deps.inbox.pending().length) })
      return Object.defineProperty({ inputId: admission.inputId }, 'admitted', { value: admitted }) as { inputId: string; admitted: Promise<void> }
    },
    async cancel(inputId) {
      if (current?.inputId === inputId) return { cancelled: false }
      const wasPending = deps.inbox.isPending(inputId)
      const front = admissions.get(inputId)
      front?.controller.abort()
      if (front) await front.admitted
      const cancelled = await deps.inbox.cancel(inputId)
      return { cancelled: cancelled || wasPending && !deps.inbox.isPending(inputId) }
    },
    cancelCurrent() {
      if (!currentAbort) return { cancelled: false }
      currentAbort.abort()
      return { cancelled: true }
    },
    pending: () => deps.inbox.pending(),
    isRunning: () => running,
    currentInput: () => current,
    drain: async () => { await Promise.allSettled([...admissions.values()].map(record => record.admitted)); await chain; {
      if (lastError !== undefined) throw lastError
    } },
    dispose() {
      disposed = true
      for (const record of admissions.values()) record.controller.abort()
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

import type {
  BackendRequirements, CompiledSandboxPolicy, ExecutionOwner, ExecutionSettlement,
  PreparedTransportExecution, ProcessSpec, StopReason, TransportExecutionBackend,
  TransportExecutionHandle,
} from "@i-harness/sandbox"
import { snapshotProcessSpec } from "@i-harness/sandbox"
import { launchExecution } from "./execution-admission.ts"

export interface ExecutionLaunch {
  backend: TransportExecutionBackend
  spec: ProcessSpec
  policy: CompiledSandboxPolicy
  requirements: BackendRequirements
  validateAuthority(policy: CompiledSandboxPolicy): void
  signal?: AbortSignal
}

export interface SupervisedExecution {
  readonly id: string
  readonly handle: TransportExecutionHandle
  readonly policy: CompiledSandboxPolicy
}
export interface ExecutionReconciliationContext { readonly phase: "preparing" | "active" }
export type ExecutionReconciler = (policy: CompiledSandboxPolicy, context: ExecutionReconciliationContext) => void

export interface ExecutionSupervisor {
  launch(request: ExecutionLaunch): Promise<SupervisedExecution>
  list(): readonly SupervisedExecution[]
  cancel(id: string, reason: StopReason): Promise<ExecutionSettlement>
  /** Re-check preparations and active policies; drain invalid ones before returning. */
  reconcile(ownerSessionId: string, validateAuthority: ExecutionReconciler): Promise<void>
  /** Blocks admission for this owner until preparation and execution ownership drains. */
  closeOwner(ownerSessionId: string): Promise<void>
  dispose(): Promise<void>
}

interface OwnerState {
  closed: boolean
  blocked: boolean
  revision: number
  reconciles: number
  closeAttempt?: Promise<void>
}
type CleanupOutcome = { kind: "cleaned" } | { kind: "failed"; cause: unknown }
const cleaned: CleanupOutcome = { kind: "cleaned" }

interface Entry {
  id: string
  owner: string
  policy: CompiledSandboxPolicy
  validateAuthority: ExecutionLaunch["validateAuthority"]
  controller: AbortController
  unlink(): void
  preparing: boolean
  prepared?: PreparedTransportExecution
  rollbackFailed: boolean
  completion: Promise<CleanupOutcome>
  complete(outcome: CleanupOutcome): void
  stopReason?: StopReason
  handle?: TransportExecutionHandle
  execution?: SupervisedExecution
  observed: Set<Promise<ExecutionSettlement>>
  rollbackAttempt?: Promise<CleanupOutcome>
}

function sameOwner(a: Readonly<ExecutionOwner>, b: Readonly<ExecutionOwner>): boolean {
  return a.sessionId === b.sessionId && a.parentSessionId === b.parentSessionId
}

function cleanupOutcome(result: ExecutionSettlement): CleanupOutcome {
  return result.kind === "incomplete"
    ? { kind: "failed", cause: new Error(`Execution cleanup incomplete (${result.phase}): ${result.detail}`) } : cleaned
}

function cleanupDetail(cause: unknown): string {
  // Rejections are opaque values. Diagnostics must not replace their identity
  // or introduce another failure when a value cannot be converted to text.
  try { return cause instanceof Error ? cause.message : String(cause) }
  catch { return "unprintable cleanup cause" }
}

function stopReason(value: unknown): StopReason {
  return value === "timeout" || value === "output-limit" || value === "authority-revoked" || value === "shutdown"
    ? value : "cancelled"
}

/** One owner for pending preparation and both transports. Only driver lease
 * observations confirm tree/I/O/resource completion; root exit never does. */
export function createExecutionSupervisor(): ExecutionSupervisor {
  const entries = new Set<Entry>()
  const owners = new Map<string, OwnerState>()
  const executionIds = new Set<string>()
  let nextId = 0
  let disposed = false
  let disposeAttempt: Promise<void> | undefined

  function ownerState(id: string): OwnerState {
    let state = owners.get(id)
    if (!state) {
      state = { closed: false, blocked: false, revision: 0, reconciles: 0 }
      owners.set(id, state)
    }
    return state
  }

  function remove(entry: Entry): void {
    entries.delete(entry)
    entry.unlink()
  }

  function watch(entry: Entry, attempt: Promise<ExecutionSettlement>): void {
    if (entry.observed.has(attempt)) return
    entry.observed.add(attempt)
    // Attach both observers immediately. A rejected driver promise leaves its
    // ownership intact and is reported by the next explicit cleanup operation.
    void attempt.then(result => {
      if (result.kind === "settled") remove(entry)
    }, () => {})
  }

  function markStopped(entry: Entry, reason: StopReason, cause: unknown = reason): void {
    entry.stopReason ??= reason
    if (!entry.controller.signal.aborted) entry.controller.abort(cause)
  }

  function cancelEntry(entry: Entry, reason: StopReason): Promise<ExecutionSettlement> {
    markStopped(entry, reason)
    try {
      const attempt = entry.handle!.cancel(reason)
      watch(entry, attempt)
      return attempt
    } catch (cause) {
      const rejected = Promise.reject<ExecutionSettlement>(cause)
      void rejected.catch(() => {})
      return rejected
    }
  }

  function checkState(entry: Entry): void {
    if (disposed) throw new Error("Execution supervisor disposed")
    if (ownerState(entry.owner).closed) throw new Error("Execution owner closed")
    if (entry.controller.signal.aborted) {
      const error = new Error("Execution admission aborted", { cause: entry.controller.signal.reason })
      error.name = "AbortError"
      throw error
    }
  }

  function fence(entry: Entry): void {
    checkState(entry)
    // Temporary reconciliation blocks new launches. Existing compatible
    // preparations use its replacement validator and may reach their fence.
    entry.validateAuthority(entry.policy)
    // A caller validator may synchronously close/reconcile this owner. Its
    // return cannot authorize a workload after that reentrant revocation.
    checkState(entry)
  }

  async function run(entry: Entry, input: ExecutionLaunch, spec: ProcessSpec, requirements: BackendRequirements): Promise<SupervisedExecution> {
    let backendId: string | undefined
    let cleanup: CleanupOutcome = cleaned
    const backend: TransportExecutionBackend = {
      async probe() {
        const probe = await input.backend.probe()
        backendId = probe.id
        return probe
      },
      async prepare(actualSpec, policy, signal) {
        const prepared = await input.backend.prepare(actualSpec, policy, signal)
        entry.prepared = prepared
        return {
          policy: prepared.policy,
          commit: validate => prepared.commit(validate),
          async rollback() {
            try {
              await prepared.rollback()
              entry.rollbackFailed = false
            } catch (cause) {
              entry.rollbackFailed = true
              cleanup = { kind: "failed", cause }
              throw cause
            }
          },
        }
      },
    }
    try {
      const handle = await launchExecution({
        backend, spec, policy: entry.policy, requirements,
        validateAuthority: () => fence(entry), signal: entry.controller.signal,
      })
      // Own the actual committed handle before receipt inspection, authority
      // checks, cancellation or exposure. A late handle cannot escape close.
      entry.handle = handle
      entry.execution = Object.freeze({ id: entry.id, handle, policy: entry.policy })
      void handle.rootExited.catch(() => {})
      watch(entry, handle.settled)
      const receipt = handle.receipt
      if (receipt.backendId !== backendId || receipt.policyFingerprint !== entry.policy.fingerprint
        || !sameOwner(receipt.owner, entry.policy.owner)) throw new Error("Execution receipt does not match admitted backend, policy or owner lineage")
      if (!receipt.executionId || executionIds.has(receipt.executionId)) throw new Error("Execution receipt has an empty or duplicate execution ID")
      executionIds.add(receipt.executionId)
      fence(entry)
      return entry.execution
    } catch (cause) {
      if (entry.handle) {
        try {
          cleanup = cleanupOutcome(await cancelEntry(entry, entry.stopReason ?? "cancelled"))
        } catch (failure) { cleanup = { kind: "failed", cause: failure } }
      } else if (!entry.rollbackFailed) remove(entry)
      if (cleanup.kind === "failed") {
        throw new AggregateError([cause, cleanup.cause], `Execution launch failed; cleanup failed: ${cleanupDetail(cleanup.cause)}`, { cause })
      }
      throw cause
    } finally {
      entry.preparing = false
      entry.complete(cleanup)
    }
  }

  function launch(input: ExecutionLaunch): Promise<SupervisedExecution> {
    try {
      const spec = snapshotProcessSpec(input.spec)
      const requirements = Object.freeze({ ...input.requirements })
      const policy = input.policy
      if (requirements.transport !== spec.transport || requirements.lifetime !== spec.lifetime) {
        throw new Error("Execution requirements do not match actual spec transport or lifetime")
      }
      if (![policy, policy.owner, policy.authorityRoots, policy.writeRoots, policy.referenceRoots].every(Object.isFrozen)) {
        throw new Error("Execution requires an immutable compiled policy, owner and root lists")
      }
      if (!sameOwner(spec.owner, policy.owner)) throw new Error("Execution spec owner or lineage does not match policy")
      const state = ownerState(spec.owner.sessionId)
      if (disposed) throw new Error("Execution supervisor disposed")
      if (state.closed) throw new Error("Execution owner closed")
      if (state.blocked || state.reconciles) throw new Error("Execution owner admission blocked")
      let complete!: (outcome: CleanupOutcome) => void
      const entry: Entry = {
        id: `execution-${++nextId}`, owner: spec.owner.sessionId, policy,
        validateAuthority: input.validateAuthority, controller: new AbortController(), unlink() {},
        preparing: true, rollbackFailed: false, observed: new Set(),
        completion: new Promise(resolve => { complete = resolve }), complete,
      }
      // Register before invoking the asynchronous admission pipeline, including
      // probe and caller validators that can synchronously reenter this owner.
      entries.add(entry)
      const callerSignal = input.signal
      if (callerSignal) {
        const abort = () => {
          markStopped(entry, stopReason(callerSignal.reason), callerSignal.reason)
          if (entry.handle) void cancelEntry(entry, entry.stopReason!).catch(() => {})
        }
        entry.unlink = () => callerSignal.removeEventListener("abort", abort)
        callerSignal.addEventListener("abort", abort, { once: true })
        if (callerSignal.aborted) abort()
      }
      const launched = run(entry, { ...input, policy }, spec, requirements)
      void launched.catch(() => {})
      return launched
    } catch (cause) {
      const rejected = Promise.reject<SupervisedExecution>(cause)
      void rejected.catch(() => {})
      return rejected
    }
  }

  async function drain(entry: Entry): Promise<CleanupOutcome> {
    // A launch already awaiting rollback or a late committed handle performs
    // its own first cleanup. Joining it must not implicitly retry an incomplete
    // attempt and accidentally acknowledge a failed revocation.
    if (entry.preparing) return entry.completion
    if (!entries.has(entry)) return cleaned
    if (entry.handle) {
      try { return cleanupOutcome(await cancelEntry(entry, entry.stopReason ?? "shutdown")) }
      catch (cause) { return { kind: "failed", cause } }
    }
    if (entry.rollbackFailed && entry.prepared) {
      if (!entry.rollbackAttempt) {
        const attempt = Promise.resolve().then(async (): Promise<CleanupOutcome> => {
          try {
            await entry.prepared!.rollback()
            entry.rollbackFailed = false
            remove(entry)
            return cleaned
          } catch (cause) { return { kind: "failed", cause } }
        })
        entry.rollbackAttempt = attempt
        void attempt.then(() => { if (entry.rollbackAttempt === attempt) entry.rollbackAttempt = undefined })
      }
      return entry.rollbackAttempt
    }
    return cleaned
  }

  async function drainAll(affected: readonly Entry[], operation: string): Promise<void> {
    const outcomes = await Promise.all(affected.map(drain))
    const errors = outcomes.flatMap(outcome => outcome.kind === "failed" ? [outcome.cause] : [])
    if (errors.length) throw new AggregateError(errors, `${operation} failed: ${errors.map(cleanupDetail).join("; ")}`)
  }

  function reconcile(owner: string, validateAuthority: ExecutionReconciler): Promise<void> {
    const state = ownerState(owner)
    const revision = ++state.revision
    state.blocked = true
    state.reconciles++
    const affected: Entry[] = []
    for (const entry of entries) {
      if (entry.owner !== owner) continue
      entry.validateAuthority = policy => validateAuthority(policy, { phase: entry.preparing ? "preparing" : "active" })
      try { entry.validateAuthority(entry.policy) }
      catch (cause) { markStopped(entry, "authority-revoked", cause) }
      if (entry.stopReason || state.closed || disposed) {
        markStopped(entry, entry.stopReason ?? "shutdown")
        affected.push(entry)
      }
    }
    const attempt = drainAll(affected, "Execution reconciliation").then(() => {
      if (state.revision === revision && !state.closed && !disposed) state.blocked = false
    }).finally(() => { state.reconciles-- })
    void attempt.catch(() => {})
    return attempt
  }

  function closeOwner(owner: string): Promise<void> {
    const state = ownerState(owner)
    state.closed = true
    state.blocked = true
    state.revision++
    if (state.closeAttempt) return state.closeAttempt
    const affected = [...entries].filter(entry => entry.owner === owner)
    affected.forEach(entry => markStopped(entry, "shutdown"))
    const attempt = drainAll(affected, "Execution owner close")
    state.closeAttempt = attempt
    void attempt.then(() => { state.closeAttempt = undefined }, () => { state.closeAttempt = undefined })
    return attempt
  }

  function dispose(): Promise<void> {
    disposed = true
    if (disposeAttempt) return disposeAttempt
    const affected = [...entries]
    affected.forEach(entry => markStopped(entry, "shutdown"))
    const attempt = drainAll(affected, "Execution supervisor disposal")
    disposeAttempt = attempt
    void attempt.then(() => { disposeAttempt = undefined }, () => { disposeAttempt = undefined })
    return attempt
  }

  return {
    launch,
    list() {
      const active: SupervisedExecution[] = []
      for (const entry of entries) {
        if (entry.handle) watch(entry, entry.handle.settled)
        if (entry.execution) active.push(entry.execution)
      }
      return Object.freeze(active)
    },
    cancel(id, reason) {
      const entry = [...entries].find(candidate => candidate.id === id)
      if (entry?.handle) return cancelEntry(entry, reason)
      const rejected = Promise.reject<ExecutionSettlement>(new Error(`Unknown supervised execution: ${id}`))
      void rejected.catch(() => {})
      return rejected
    },
    reconcile, closeOwner, dispose,
  }
}

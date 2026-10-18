import type { BackendRequirements, CompiledSandboxPolicy, ExecutionOwner, ExecutionSettlement, ProcessSpec, StopReason, TransportExecutionBackend } from "@i-harness/sandbox"
import { snapshotProcessSpec } from "@i-harness/sandbox"
import { launchExecution } from "../execution-admission.ts"
import { cleaned, type CleanupOutcome, type Entry, type ExecutionLaunch, type OwnerState, type SupervisedExecution } from "./contracts.ts"
import { cleanupDetail, cleanupOutcome } from "./retirement.ts"

function sameOwner(a: Readonly<ExecutionOwner>, b: Readonly<ExecutionOwner>): boolean {
  return a.sessionId === b.sessionId && a.parentSessionId === b.parentSessionId
}

function stopReason(value: unknown): StopReason {
  return value === "timeout" || value === "output-limit" || value === "authority-revoked" || value === "shutdown"
    ? value : "cancelled"
}

interface AdmissionOwner {
  isDisposed(): boolean
  ownerState(id: string): OwnerState
  register(owner: string, policy: CompiledSandboxPolicy, readValidator: () => ExecutionLaunch["validateAuthority"]): Entry
  hasExecutionId(id: string): boolean
  rememberExecutionId(id: string): void
  remove(entry: Entry): void
  watch(entry: Entry, attempt: Promise<ExecutionSettlement>): void
  markStopped(entry: Entry, reason: StopReason, cause?: unknown): void
  cancelEntry(entry: Entry, reason: StopReason): Promise<ExecutionSettlement>
}

export function createAdmission(owner: AdmissionOwner): ExecutionLaunchFunction {
  const { isDisposed, ownerState, register, hasExecutionId, rememberExecutionId, remove, watch, markStopped, cancelEntry } = owner

  function checkState(entry: Entry): void {
    if (isDisposed()) throw new Error("Execution supervisor disposed")
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
      if (!receipt.executionId || hasExecutionId(receipt.executionId)) throw new Error("Execution receipt has an empty or duplicate execution ID")
      rememberExecutionId(receipt.executionId)
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
      if (isDisposed()) throw new Error("Execution supervisor disposed")
      if (state.closed) throw new Error("Execution owner closed")
      if (state.blocked || state.reconciles) throw new Error("Execution owner admission blocked")
      const entry = register(spec.owner.sessionId, policy, () => input.validateAuthority)
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

  return launch
}

type ExecutionLaunchFunction = (input: ExecutionLaunch) => Promise<SupervisedExecution>

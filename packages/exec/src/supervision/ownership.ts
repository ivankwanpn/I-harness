import type { CompiledSandboxPolicy, ExecutionSettlement } from "@i-harness/sandbox"
import { type CleanupOutcome, type Entry, type ExecutionLaunch, type ExecutionSupervisor, type OwnerState, type SupervisedExecution } from "./contracts.ts"
import { createAdmission } from "./admission.ts"
import { createRetirement } from "./retirement.ts"
import { createReconciliation } from "./reconciliation.ts"

/** The only registry, ID allocator, owner fence and disposal-attempt owner. */
export function createSupervisionOwner(): ExecutionSupervisor {
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

  function register(owner: string, policy: CompiledSandboxPolicy, readValidator: () => ExecutionLaunch["validateAuthority"]): Entry {
    let complete!: (outcome: CleanupOutcome) => void
    // Read the caller getter after allocating the ID, as in the original entry
    // initializer. A throwing getter still consumes that admission number.
    const entry: Entry = {
      id: `execution-${++nextId}`, owner, policy,
      validateAuthority: readValidator(), controller: new AbortController(), unlink() {},
      preparing: true, rollbackFailed: false, observed: new Set(),
      completion: new Promise(resolve => { complete = resolve }), complete,
    }
    // Register before invoking the asynchronous admission pipeline, including
    // probe and caller validators that can synchronously reenter this owner.
    entries.add(entry)
    return entry
  }

  const { watch, markStopped, cancelEntry, drainAll } = createRetirement({ owns: entry => entries.has(entry), remove })
  const launch = createAdmission({ isDisposed: () => disposed, ownerState, register,
    hasExecutionId: id => executionIds.has(id), rememberExecutionId: id => { executionIds.add(id) },
    remove, watch, markStopped, cancelEntry })
  const { reconcile, closeOwner } = createReconciliation({ ownerState, entries: () => entries, isDisposed: () => disposed, markStopped, drainAll })

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

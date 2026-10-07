import type {
  ExecutionHandle, ExecutionReceipt, ExecutionSettlement, RootExit, StopReason,
} from "./execution.ts"

type Observation<T> = { ok: true; value: T } | { ok: false; detail: string }
type Incomplete = Extract<ExecutionSettlement, { kind: "incomplete" }>
interface Termination {
  promise: Promise<Observation<void>>
  result?: Observation<void>
}
interface Attempt {
  promise: Promise<ExecutionSettlement>
  resolve(result: ExecutionSettlement): void
  active: boolean
  releaseReserved: boolean
  termination?: Termination
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// Convert rejection to data immediately, even when another phase is still pending.
async function observe<T>(hook: () => Promise<T>): Promise<Observation<T>> {
  try { return { ok: true, value: await hook() } }
  catch (cause) { return { ok: false, detail: failureDetail(cause) } }
}

/**
 * Owns one execution's asynchronous cleanup. Hooks confirm native facts; this
 * lease cannot infer tree exit or I/O completion from the root's exit alone.
 * An incomplete attempt retains resources until an explicit cancel/release retry.
 */
export function createExecutionLease(input: {
  receipt: ExecutionReceipt
  rootExited: Promise<RootExit>
  waitTreeEmpty(): Promise<void>
  settleIo(): Promise<void>
  releaseResources(): Promise<void>
  terminate(reason: StopReason): Promise<void>
}): ExecutionHandle {
  const receipt = Object.freeze({
    ...input.receipt, owner: Object.freeze({ ...input.receipt.owner }),
  })
  // Unknown root status is a reporting failure, independent of tree/I/O facts.
  // Normalize it immediately so public observers retain a diagnostic as data.
  const root: Promise<RootExit> = input.rootExited.then(value => value, cause => ({
    exitCode: null,
    observationError: failureDetail(cause).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim(),
  }))
  let treeEmpty = false
  let ioSettled = false
  let resourcesReleased = false
  let terminatedReason: StopReason | undefined
  let nativeTermination: Termination | undefined
  let current: Attempt

  function incomplete(phase: Incomplete["phase"], detail: string): Incomplete {
    return { kind: "incomplete", phase, detail }
  }

  function complete(attempt: Attempt, result: ExecutionSettlement): void {
    // Close admission and publish the historical result in the same turn. An
    // outer await continuation must never leave a completed computation active.
    attempt.active = false
    attempt.resolve(result)
  }

  async function settle(attempt: Attempt): Promise<void> {
    let failure: Incomplete | undefined
    if (!treeEmpty) {
      const tree = await observe(() => input.waitTreeEmpty())
      if (tree.ok) treeEmpty = true
      else failure = incomplete("tree", tree.detail)
    }
    if (treeEmpty && !ioSettled) {
      const io = await observe(() => input.settleIo())
      if (io.ok) ioSettled = true
      else failure = incomplete("io", io.detail)
    }

    // Reserve closure synchronously before awaiting a termination or root
    // observation. Once the tree is empty, late cancellation only joins cleanup.
    if (treeEmpty && ioSettled) attempt.releaseReserved = true
    // Any termination admitted before tree confirmation belongs to this attempt.
    // Resources remain owned until that already-started termination is known.
    if (attempt.termination) {
      const termination = await attempt.termination.promise
      if (!termination.ok) {
        return complete(attempt, incomplete("tree", failure
          ? `termination failed: ${termination.detail}; ${failure.phase}: ${failure.detail}`
          : `termination failed: ${termination.detail}`))
      }
    }
    if (failure) return complete(attempt, failure)

    const rootExit = await root
    if (!resourcesReleased) {
      const released = await observe(() => input.releaseResources())
      if (!released.ok) return complete(attempt, incomplete("release", released.detail))
      resourcesReleased = true
    }
    complete(attempt, {
      kind: "settled", root: rootExit,
      treeEmpty: true, ioSettled: true, resourcesReleased: true,
    })
  }

  function start(): Attempt {
    let resolve!: (value: ExecutionSettlement) => void
    const attempt: Attempt = {
      promise: new Promise<ExecutionSettlement>(done => { resolve = done }),
      resolve, active: true,
      releaseReserved: treeEmpty && ioSettled,
    }
    // Native ownership outlives an attempt. Carry any unresolved termination
    // into a new owner before that owner can observe or release resources.
    if (nativeTermination && nativeTermination.result === undefined) attempt.termination = nativeTermination
    // Publish the attempt before invoking any hook, including synchronous hooks.
    void Promise.resolve().then(() => settle(attempt))
    return attempt
  }

  function release(): Promise<ExecutionSettlement> {
    if (!current.active && !resourcesReleased) current = start()
    return current.promise
  }

  function cancel(reason: StopReason): Promise<ExecutionSettlement> {
    const promise = release()
    if (!resourcesReleased && !treeEmpty && !current.releaseReserved
      && terminatedReason === undefined && !current.termination) {
      if (nativeTermination && nativeTermination.result === undefined) {
        current.termination = nativeTermination
        return promise
      }
      let resolve!: (result: Observation<void>) => void
      // Reserve ownership before a hook can synchronously reenter cancel.
      const termination: Termination = { promise: new Promise(done => { resolve = done }) }
      nativeTermination = termination
      current.termination = termination
      void observe(() => input.terminate(reason)).then(result => {
        termination.result = result
        if (result.ok) {
          terminatedReason = reason
        }
        resolve(result)
      })
    }
    return promise
  }

  current = start()
  return Object.freeze({
    receipt, rootExited: root,
    get settled() { return current.promise },
    cancel, release,
  })
}

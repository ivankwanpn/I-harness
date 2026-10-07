import type {
  ExecutionHandle, ExecutionReceipt, ExecutionSettlement, RootExit, StopReason,
} from "./execution.ts"

type Observation<T> = { ok: true; value: T } | { ok: false; detail: string }
type Incomplete = Extract<ExecutionSettlement, { kind: "incomplete" }>
interface Attempt {
  promise: Promise<ExecutionSettlement>
  active: boolean
  termination?: Promise<Observation<void>>
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
  const root = observe(() => input.rootExited)
  let treeEmpty = false
  let ioSettled = false
  let resourcesReleased = false
  let terminatedReason: StopReason | undefined
  let terminationFailed = false
  let current: Attempt

  function incomplete(phase: Incomplete["phase"], detail: string): Incomplete {
    return { kind: "incomplete", phase, detail }
  }

  async function settle(attempt: Attempt): Promise<ExecutionSettlement> {
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

    // Cancellation may join while tree/I/O observations are pending. Its failure
    // is part of this attempt, so no resources can release until it is known.
    if (attempt.termination) {
      const termination = await attempt.termination
      if (!termination.ok) {
        return incomplete("tree", failure
          ? `termination failed: ${termination.detail}; ${failure.phase}: ${failure.detail}`
          : `termination failed: ${termination.detail}`)
      }
    }
    if (failure) return failure

    const rootExit = await root
    if (!rootExit.ok) return incomplete("tree", `root exit observation failed: ${rootExit.detail}`)
    if (!resourcesReleased) {
      const released = await observe(() => input.releaseResources())
      if (!released.ok) return incomplete("release", released.detail)
      resourcesReleased = true
    }
    return {
      kind: "settled", root: rootExit.value,
      treeEmpty: true, ioSettled: true, resourcesReleased: true,
    }
  }

  function start(): Attempt {
    let resolve!: (value: ExecutionSettlement) => void
    const attempt: Attempt = {
      promise: new Promise<ExecutionSettlement>(done => { resolve = done }), active: true,
    }
    // Publish the attempt before invoking any hook, including synchronous hooks.
    void Promise.resolve().then(async () => {
      const result = await settle(attempt)
      attempt.active = false
      resolve(result)
    })
    return attempt
  }

  function release(): Promise<ExecutionSettlement> {
    if (!current.active && !resourcesReleased) current = start()
    return current.promise
  }

  function cancel(reason: StopReason): Promise<ExecutionSettlement> {
    const promise = release()
    if (!resourcesReleased && terminatedReason === undefined && !current.termination
      && (!treeEmpty || terminationFailed)) {
      let resolve!: (result: Observation<void>) => void
      // Reserve ownership before a hook can synchronously reenter cancel.
      current.termination = new Promise(done => { resolve = done })
      void observe(() => input.terminate(reason)).then(result => {
        if (result.ok) {
          terminatedReason = reason
          terminationFailed = false
        } else terminationFailed = true
        resolve(result)
      })
    }
    return promise
  }

  current = start()
  return Object.freeze({
    receipt, rootExited: input.rootExited,
    get settled() { return current.promise },
    cancel, release,
  })
}

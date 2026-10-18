import { readInbox, subscribe } from "@i-harness/core-session"
import type { ToolExec } from "./index.ts"

export interface ObservationChanges { subscribe(listener: () => void): () => void }
export interface UserSteerSource extends ObservationChanges { pending(): boolean }
export type ObservationReason = "ready" | "deadline" | "user-steer" | "aborted"
export interface ObservationOptions {
  ready(): boolean
  changes: ObservationChanges
  timeoutMs?: number
  abortSignal?: AbortSignal
  userSteer?: UserSteerSource
}

/** Observe an owner's state without taking ownership of its work or input. */
export function waitForObservation(options: ObservationOptions): Promise<ObservationReason> {
  return new Promise((resolve, reject) => {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      reject(new RangeError("observation timeoutMs must be finite and nonnegative"))
      return
    }
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs
    const cleanups: (() => void)[] = []
    const errors: unknown[] = []
    let decided = false, setupComplete = false, settled = false
    let reason: ObservationReason | undefined
    const own = (off: () => void) => { cleanups.push(off) }
    const complete = () => {
      // A source can synchronously decide the observation before returning its
      // disposer. Keep that decision latched, but include all setup/cleanup
      // failures before publishing the promise's result.
      if (!decided || !setupComplete || settled) return
      settled = true
      for (const off of cleanups.splice(0)) {
        try { off() } catch (error) { errors.push(error) }
      }
      if (errors.length === 1) reject(errors[0])
      else if (errors.length > 1) reject(new AggregateError(errors, "Observation failed during setup, check, or cleanup"))
      else resolve(reason!)
    }
    const fail = (error: unknown) => {
      errors.push(error)
      decided = true
      complete()
    }
    const finish = (value: ObservationReason) => {
      if (decided) return
      reason = value
      decided = true
      complete()
    }
    const check = () => {
      if (decided) return
      try {
        if (options.abortSignal?.aborted) finish("aborted")
        else if (options.ready()) finish("ready")
        else if (options.userSteer?.pending()) finish("user-steer")
        else if (Date.now() >= deadline) finish("deadline")
      } catch (error) { fail(error) }
    }
    try {
      own(options.changes.subscribe(check))
      if (!decided && options.userSteer) own(options.userSteer.subscribe(check))
      if (!decided && options.abortSignal) {
        const signal = options.abortSignal
        signal.addEventListener("abort", check, { once: true })
        own(() => signal.removeEventListener("abort", check))
      }
      if (!decided && deadline !== Infinity) {
        let timer: ReturnType<typeof setTimeout>
        const armDeadline = () => {
          // Node clamps larger delays to 1ms. Segment only the deadline,
          // retaining one active timer even after a backward wall-clock step.
          timer = setTimeout(() => {
            check()
            if (!decided) armDeadline()
          }, Math.min(2 ** 31 - 1, Math.max(0, deadline - Date.now())))
        }
        armDeadline()
        own(() => clearTimeout(timer))
      }
      check()
    } catch (error) { fail(error) }
    finally { setupComplete = true; complete() }
  })
}

export function userSteerForTool(exec: ToolExec): UserSteerSource | undefined {
  if (!exec.session || exec.resultConsumer === "code") return undefined
  const session = exec.session
  return {
    pending: () => readInbox(session).pending().some(input => input.intent === "user" && input.delivery === "steer"),
    subscribe: listener => subscribe(session, event => {
      if (event.type === "agent/input/admitted" || event.type === "agent/input/promoted" || event.type === "agent/input/cancelled") listener()
    }),
  }
}

import { AsyncLocalStorage } from "node:async_hooks"
import type { ExecutionOwner } from "@i-harness/sandbox"

const callers = new AsyncLocalStorage<Readonly<ExecutionOwner>>()

/** Trusted dispatch binds this owner before invoking tools; command JSON cannot set it. */
export function withExecCallerScope<T>(owner: ExecutionOwner, call: () => T): T {
  if (!owner.sessionId || owner.sessionId.includes("\0") || (owner.parentSessionId !== undefined && (!owner.parentSessionId || owner.parentSessionId.includes("\0")))) {
    throw new Error("Invalid execution caller owner")
  }
  const bound = Object.freeze({ sessionId: owner.sessionId, ...(owner.parentSessionId === undefined ? {} : { parentSessionId: owner.parentSessionId }) })
  return callers.run(bound, call)
}

export function currentExecCaller(): Readonly<ExecutionOwner> | undefined { return callers.getStore() }

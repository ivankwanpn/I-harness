import { EventEmitter } from "node:events"
import { vi } from "vitest"

export function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Only the native boundary is replaced; classification, buffering and drain stay real. */
export class PushWatcher extends EventEmitter {
  close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  ready() { this.emit("ready") }
  change(kind: string, path: string) { this.emit("all", kind, path) }
  fail(error = new Error("backend fault")) { this.emit("error", error) }
}

export async function turns(count = 20) {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

export function watchdog<T>(promise: Promise<T>, ms = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watchdog expired")), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

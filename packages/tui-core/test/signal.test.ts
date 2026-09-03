// G2 signal — pure SignalGate first/second policy + wiring against an injected
// emitter stub (fake timers for the 1000ms grace window).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installSignalHandlers, SignalGate, type SignalEmitter } from "../src/signal/index.ts"

describe("SignalGate", () => {
  it("first → graceful, second → force, reset re-arms", () => {
    const gate = new SignalGate()
    expect(gate.first()).toBe("graceful")
    expect(gate.isArmed).toBe(true)
    expect(gate.first()).toBe("force")
    gate.reset()
    expect(gate.isArmed).toBe(false)
    expect(gate.first()).toBe("graceful")
  })
})

type Handler = () => void

function makeEmitter(): SignalEmitter & { emit(signal: string): void } {
  const multi = new Map<string, Set<Handler>>()
  const onceMap = new Map<string, Set<Handler>>()
  const run = (h: Handler): void => h()
  return {
    on(signal, fn) {
      let set = multi.get(signal)
      if (set === undefined) {
        set = new Set()
        multi.set(signal, set)
      }
      set.add(fn)
    },
    once(signal, fn) {
      let set = onceMap.get(signal)
      if (set === undefined) {
        set = new Set()
        onceMap.set(signal, set)
      }
      set.add(fn)
    },
    off(signal, fn) {
      multi.get(signal)?.delete(fn)
      onceMap.get(signal)?.delete(fn)
    },
    emit(signal) {
      for (const fn of [...(multi.get(signal) ?? [])]) run(fn)
      const once = onceMap.get(signal)
      if (once !== undefined && once.size > 0) {
        onceMap.delete(signal)
        for (const fn of [...once]) run(fn)
      }
    },
  }
}

describe("installSignalHandlers", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("first signal graceful, second within the window force, uninstall stops everything", () => {
    const emitter = makeEmitter()
    const graceful = vi.fn()
    const force = vi.fn()
    const uninstall = installSignalHandlers({ graceful, force }, emitter)

    emitter.emit("SIGINT")
    expect(graceful).toHaveBeenCalledTimes(1)
    expect(force).not.toHaveBeenCalled()

    emitter.emit("SIGINT") // within 1000ms → force
    expect(force).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1001) // window closes → gate re-arms
    emitter.emit("SIGTERM")
    expect(graceful).toHaveBeenCalledTimes(2)

    emitter.emit("SIGBREAK") // Windows driver signal
    expect(force).toHaveBeenCalledTimes(2)

    uninstall()
    emitter.emit("SIGINT")
    emitter.emit("SIGBREAK")
    expect(graceful).toHaveBeenCalledTimes(2)
    expect(force).toHaveBeenCalledTimes(2)
  })

  it("exit hook runs graceful exactly once for an otherwise untouched run", () => {
    const emitter = makeEmitter()
    const graceful = vi.fn()
    const force = vi.fn()
    installSignalHandlers({ graceful, force }, emitter)

    emitter.emit("exit")
    expect(graceful).toHaveBeenCalledTimes(1) // final cleanup

    emitter.emit("exit") // once-registered — must not fire again
    expect(graceful).toHaveBeenCalledTimes(1)
  })

  it("exit hook skips when a graceful is already in progress", () => {
    const emitter = makeEmitter()
    const graceful = vi.fn()
    const force = vi.fn()
    installSignalHandlers({ graceful, force }, emitter)

    emitter.emit("SIGINT") // graceful now
    emitter.emit("exit") // already armed → no second cleanup
    expect(graceful).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, expect, it, vi } from "vitest"
import { createSession, Inbox } from "@i-harness/core-session"
import { userSteerForTool, waitForObservation } from "../src/observation.ts"

afterEach(() => vi.useRealTimers())
function source() {
  const listeners = new Set<() => void>()
  return { listeners, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }, emit() { for (const fn of [...listeners]) fn() } }
}
it("broadcasts steer without consuming input or keeping timers/listeners", async () => {
  vi.useFakeTimers()
  const session = createSession(), inbox = new Inbox(session), changes = source()
  const userSteer = userSteerForTool({ session })
  const waits = [0, 1].map(() => waitForObservation({ ready: () => false, changes, timeoutMs: 30_000, userSteer }))
  expect(vi.getTimerCount()).toBe(2)
  inbox.admit({ inputId: "steer-1", text: "change focus", intent: "user", delivery: "steer" })
  expect(await Promise.all(waits)).toEqual(["user-steer", "user-steer"])
  expect(inbox.pending().map(row => row.inputId)).toEqual(["steer-1"])
  expect(session.events.some(row => row.type === "user/message")).toBe(false)
  expect(changes.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(userSteerForTool({ session, resultConsumer: "code" })).toBeUndefined()
  expect(userSteerForTool({})).toBeUndefined()
})
it.each(["before", "during"])("observes readiness %s subscription and disposes synchronous subscriptions", async timing => {
  vi.useFakeTimers()
  let ready = timing === "before", disposed = 0
  const changes = { subscribe(fn: () => void) { ready = true; fn(); return () => { disposed++ } } }
  expect(await waitForObservation({ ready: () => ready, changes, timeoutMs: 100 })).toBe("ready")
  expect(disposed).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})
it.each(["pending", "cancelled", "promoted", "queue", "system"])("checks current inbox state: %s", async state => {
  vi.useFakeTimers()
  const session = createSession(), inbox = new Inbox(session)
  inbox.admit({ inputId: "one", text: "input", intent: state === "system" ? "system" : "user", delivery: state === "queue" ? "queue" : "steer" })
  if (state === "cancelled") inbox.cancel("one")
  if (state === "promoted") inbox.claimAtStepBoundary()
  const waiting = waitForObservation({ ready: () => false, changes: source(), timeoutMs: 100, userSteer: userSteerForTool({ session }) })
  await vi.advanceTimersByTimeAsync(100)
  expect(await waiting).toBe(state === "pending" ? "user-steer" : "deadline")
  expect(vi.getTimerCount()).toBe(0)
})
it("ignores live queue/system admissions and releases every observer on pending user admission", async () => {
  vi.useFakeTimers()
  const session = createSession(), inbox = new Inbox(session), changes = source()
  const waits = [0, 1].map(() => waitForObservation({ ready: () => false, changes, timeoutMs: 100, userSteer: userSteerForTool({ session }) }))
  inbox.admit({ inputId: "queue", text: "queue", intent: "user", delivery: "queue" })
  inbox.admit({ inputId: "system", text: "system", intent: "system", delivery: "steer" })
  expect(changes.listeners.size).toBe(2)
  inbox.admit({ inputId: "human", text: "human", intent: "user", delivery: "steer" })
  inbox.cancel("human")
  expect(await Promise.all(waits)).toEqual(["user-steer", "user-steer"])
  expect(vi.getTimerCount()).toBe(0)
})
it.each(["before", "during"])("gives explicit abort priority %s observation without changing owner state", async timing => {
  vi.useFakeTimers()
  const controller = new AbortController(), changes = source()
  const remove = vi.spyOn(controller.signal, "removeEventListener")
  if (timing === "before") controller.abort()
  const waiting = waitForObservation({ ready: () => timing === "before", changes, timeoutMs: 100, abortSignal: controller.signal })
  if (timing === "during") controller.abort()
  expect(await waiting).toBe("aborted")
  expect(remove).toHaveBeenCalled()
  expect(changes.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
it("checks readiness before a deadline in the same tick and has only one original timer", async () => {
  vi.useFakeTimers()
  const timers = vi.spyOn(globalThis, "setTimeout")
  const changes = source()
  const until = Date.now() + 30_000
  const waiting = waitForObservation({ ready: () => Date.now() >= until, changes, timeoutMs: 30_000 })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(vi.getTimerCount()).toBe(1)
  expect(timers).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await waiting).toBe("ready")
  expect(changes.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
it.each(["deadline", "ready", "steer"])("segments large deadlines with one active timer and cleans up on %s", async reason => {
  vi.useFakeTimers()
  const changes = source(), steer = source()
  let ready = false, pending = false
  const waiting = waitForObservation({ ready: () => ready, changes, timeoutMs: 2 ** 31 + 100,
    userSteer: { pending: () => pending, subscribe: steer.subscribe } })
  await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
  expect(changes.listeners.size).toBe(1)
  expect(vi.getTimerCount()).toBe(1)
  if (reason === "ready") { ready = true; changes.emit() }
  else if (reason === "steer") { pending = true; steer.emit() }
  else await vi.advanceTimersByTimeAsync(101)
  expect(await waiting).toBe(reason === "steer" ? "user-steer" : reason)
  expect(changes.listeners.size + steer.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
it("retains one deadline timer when the wall clock moves backward", async () => {
  vi.useFakeTimers()
  const changes = source(), now = Date.now()
  const waiting = waitForObservation({ ready: () => false, changes, timeoutMs: 100 })
  vi.setSystemTime(now - 100)
  await vi.advanceTimersByTimeAsync(100)
  expect(changes.listeners.size).toBe(1)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(100)
  expect(await waiting).toBe("deadline")
  expect(vi.getTimerCount()).toBe(0)
})
it.each(["ready", "pending", "subscribe"])("cleans all resources when %s throws", async where => {
  vi.useFakeTimers()
  const changes = source(), steer = source()
  const boom = () => { throw new Error("broken predicate") }
  const waiting = waitForObservation({ ready: where === "ready" ? boom : () => false, changes, timeoutMs: 100,
    userSteer: { pending: where === "pending" ? boom : () => false, subscribe: where === "subscribe" ? boom : steer.subscribe } })
  await expect(waiting).rejects.toThrow("broken predicate")
  expect(changes.listeners.size + steer.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
it.each(["ready", "steer"])("allows an unbounded observer with no timer to settle on %s", async reason => {
  vi.useFakeTimers()
  let pending = false
  const changes = source()
  const waiting = waitForObservation({ ready: () => reason === "ready" && pending, changes,
    userSteer: { pending: () => reason === "steer" && pending, subscribe: changes.subscribe } })
  expect(vi.getTimerCount()).toBe(0)
  pending = true; changes.emit()
  expect(await waiting).toBe(reason === "ready" ? "ready" : "user-steer")
  expect(changes.listeners.size).toBe(0)
})
it.each([-1, NaN, Infinity])("rejects invalid timeout %s without resources", async timeoutMs => {
  const changes = source()
  await expect(waitForObservation({ ready: () => false, changes, timeoutMs })).rejects.toThrow()
  expect(changes.listeners.size).toBe(0)
})

import { afterEach, expect, it, vi } from "vitest"
import { createRefreshScheduler } from "../src/renderer/session/refresh-scheduler.ts"

afterEach(() => vi.useRealTimers())

it("coalesces bursts and serializes a follow-up when events arrive during a read", async () => {
  vi.useFakeTimers()
  let release!: () => void
  const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
  const scheduler = createRefreshScheduler(refresh)
  for (let i = 0; i < 100; i++) scheduler.schedule()
  await vi.advanceTimersByTimeAsync(200)
  expect(refresh).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 100; i++) scheduler.schedule()
  await vi.advanceTimersByTimeAsync(1000)
  expect(refresh).toHaveBeenCalledTimes(1)
  release()
  await vi.advanceTimersByTimeAsync(200)
  expect(refresh).toHaveBeenCalledTimes(2)
  scheduler.dispose()
  release()
})

it("discards queued work after disposal and recovers from failed reads", async () => {
  vi.useFakeTimers()
  const refresh = vi.fn().mockRejectedValue(new Error("offline"))
  const scheduler = createRefreshScheduler(refresh)
  scheduler.schedule()
  await vi.advanceTimersByTimeAsync(200)
  scheduler.schedule()
  await vi.advanceTimersByTimeAsync(200)
  expect(refresh).toHaveBeenCalledTimes(2)
  scheduler.schedule()
  scheduler.dispose()
  scheduler.schedule()
  await vi.runAllTimersAsync()
  expect(refresh).toHaveBeenCalledTimes(2)
})

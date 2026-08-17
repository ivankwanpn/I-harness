import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { SessionWriteBehind } from "../src/write-behind.ts"

afterEach(() => { vi.useRealTimers() })

describe("SessionWriteBehind", () => {
  it("uses one fixed window from the first queued event and owns its copy", async () => {
    vi.useFakeTimers()
    const batches: SessionEvent[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async (events) => { batches.push(structuredClone(events) as SessionEvent[]) },
      reportBackgroundFailure: vi.fn(),
    })
    const first: SessionEvent = { type: "user/message", text: "hi" }
    controller.enqueue(first)
    ;(first as { text: string }).text = "mutated" // after enqueue: controller must own a copy
    await vi.advanceTimersByTimeAsync(150)
    controller.enqueue({ type: "turn/end" })
    await vi.advanceTimersByTimeAsync(49)
    expect(batches).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(batches).toEqual([
      [{ type: "user/message", text: "hi" }, { type: "turn/end" }],
    ])
    expect(controller.hasWork).toBe(false)
  })

  it("coalesces events admitted inside one window into a single batch", async () => {
    vi.useFakeTimers()
    const batches: SessionEvent[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async (events) => { batches.push(events) },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue({ type: "turn/start" })
    for (let i = 0; i < 9; i += 1) {
      await vi.advanceTimersByTimeAsync(10)
      controller.enqueue({ type: "assistant/chunk", text: String(i) })
    }
    expect(batches).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(10)
    expect(controller.hasWork).toBe(false)
  })

  it("flush drains pending and concurrent callers join the same barrier", async () => {
    const batches: SessionEvent[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 1000,
      write: async (events) => { batches.push(events) },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue({ type: "turn/start" })
    controller.enqueue({ type: "turn/end" })
    const first = controller.flush()
    const second = controller.flush()
    await Promise.all([first, second])
    expect(batches).toEqual([[{ type: "turn/start" }, { type: "turn/end" }]])
    expect(controller.hasWork).toBe(false)
  })

  it("reports a failed background write, retains the batch, and retries on flush", async () => {
    vi.useFakeTimers()
    let calls = 0
    const report = vi.fn()
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async () => {
        calls += 1
        if (calls === 1) throw new Error("disk full")
      },
      reportBackgroundFailure: report,
    })
    controller.enqueue({ type: "turn/start" })
    await vi.advanceTimersByTimeAsync(200) // deadline fires; background write fails
    expect(report).toHaveBeenCalledTimes(1)
    expect(controller.hasWork).toBe(true) // batch retained for retry
    await controller.flush() // retry drains
    expect(calls).toBe(2)
    expect(controller.hasWork).toBe(false)
  })

  it("flush rejects when a durable write fails", async () => {
    const controller = new SessionWriteBehind({
      maxDelayMs: 1000,
      write: async () => { throw new Error("io error") },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue({ type: "turn/start" })
    await expect(controller.flush()).rejects.toThrow("io error")
    expect(controller.hasWork).toBe(true) // retained for retry
  })

  it("hasWork is true while pending or active and false when quiescent", async () => {
    const controller = new SessionWriteBehind({
      maxDelayMs: 1000,
      write: async () => {},
      reportBackgroundFailure: vi.fn(),
    })
    expect(controller.hasWork).toBe(false)
    controller.enqueue({ type: "turn/start" })
    expect(controller.hasWork).toBe(true)
    await controller.flush()
    expect(controller.hasWork).toBe(false)
  })

  it("cancelAutomaticWait clears the timer and preserves retained work", async () => {
    vi.useFakeTimers()
    const batches: SessionEvent[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async (events) => { batches.push(events) },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue({ type: "turn/start" })
    controller.cancelAutomaticWait() // cancel before the deadline can fire
    await vi.advanceTimersByTimeAsync(500) // no automatic write: the timer was cancelled
    expect(batches).toEqual([])
    expect(controller.hasWork).toBe(true) // pending preserved
    await controller.flush() // explicit drain still works after the cancel
    expect(batches).toEqual([[{ type: "turn/start" }]])
    expect(controller.hasWork).toBe(false)
    controller.enqueue({ type: "turn/end" }) // after the cancel (like post-close) a later enqueue arms a fresh window
    await vi.advanceTimersByTimeAsync(200)
    expect(batches).toEqual([
      [{ type: "turn/start" }],
      [{ type: "turn/end" }],
    ])
    expect(controller.hasWork).toBe(false)
    vi.useRealTimers()
  })

  it("latches deadlineExpired when the deadline fires during an active write", async () => {
    vi.useFakeTimers()
    const batches: SessionEvent[][] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    let first = true
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async (events) => {
        batches.push(events)
        if (first) { first = false; await gate }
      },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue({ type: "turn/start" }) // t=0 arms the 200 ms window
    await vi.advanceTimersByTimeAsync(200) // deadline: starts the background write (now active)
    controller.enqueue({ type: "turn/end" }) // pending is empty again, so a fresh deadline arms
    await vi.advanceTimersByTimeAsync(500) // deadline fires mid-active → deadlineExpired latched
    expect(batches).toHaveLength(1) // the active write is still in flight: no second write yet
    release() // let the active write settle
    await vi.advanceTimersByTimeAsync(0)
    expect(batches).toHaveLength(2) // continueAutomatic starts the latched write
    expect(batches[1]).toEqual([{ type: "turn/end" }])
    expect(controller.hasWork).toBe(false)
    vi.useRealTimers()
  })
})

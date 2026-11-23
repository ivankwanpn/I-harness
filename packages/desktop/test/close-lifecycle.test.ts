import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import { attachCloseLifecycle } from "../src/main/close-lifecycle.ts"

class WindowStub extends EventEmitter {
  destroyed = false
  hide = vi.fn()
  minimize = vi.fn()
  isDestroyed = () => this.destroyed
  close = vi.fn(() => {
    const event = { preventDefault: vi.fn() }
    this.emit("close", event)
    if (event.preventDefault.mock.calls.length === 0) { this.destroyed = true; this.emit("closed") }
    return event
  })
}

describe("Desktop close lifecycle", () => {
  it.each([false, true])("finishes the pending close after background work settles, reopened=%s", async reopened => {
    vi.useFakeTimers()
    try {
      const window = new WindowStub()
      const hasActiveWork = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
      attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => true, quitState: () => "running" })
      window.close()
      await vi.advanceTimersByTimeAsync(1)
      expect(window.destroyed).toBe(false)
      if (reopened) window.emit("show")
      await vi.advanceTimersByTimeAsync(6000)
      expect(window.destroyed).toBe(!reopened)
      expect(hasActiveWork).toHaveBeenCalledTimes(reopened ? 1 : 2)
    } finally { vi.useRealTimers() }
  })
  it("hides active work with a tray and keeps the window alive", async () => {
    const window = new WindowStub()
    const hasActiveWork = vi.fn(async () => true)
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => true, quitState: () => "running" })
    const first = window.close()
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()
    expect(window.destroyed).toBe(false)
    expect(window.minimize).not.toHaveBeenCalled()
  })

  it("minimizes active work when tray creation failed", async () => {
    const window = new WindowStub()
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork: async () => true, trayAvailable: () => false, quitState: () => "running" })
    window.close()
    expect(window.minimize).toHaveBeenCalledOnce()
    expect(window.hide).not.toHaveBeenCalled()
    expect(window.destroyed).toBe(false)
  })

  it("allows the second close event for an idle workspace", async () => {
    const window = new WindowStub()
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork: async () => false, trayAvailable: () => true, quitState: () => "running" })
    window.close()
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledTimes(2))
    expect(window.destroyed).toBe(true)
    expect(window.hide).toHaveBeenCalledOnce()
  })

  it.each(["restore", "show"])("abandons the earlier idle decision when the user reopens via %s", async (event) => {
    const window = new WindowStub()
    const earlier = Promise.withResolvers<boolean>()
    const latest = Promise.withResolvers<boolean>()
    const hasActiveWork = vi.fn().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise)
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => event === "show", quitState: () => "running" })
    window.close()
    window.emit(event)
    window.close()
    earlier.resolve(false)
    await new Promise(resolve => setImmediate(resolve))
    expect(window.destroyed).toBe(false)
    latest.resolve(false)
    await vi.waitFor(() => expect(window.destroyed).toBe(true))
  })

  it("retains the window while an explicit quit is draining its original resources", () => {
    const window = new WindowStub()
    const hasActiveWork = vi.fn(async () => false)
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => true, quitState: () => "draining" })
    expect(window.close().preventDefault).toHaveBeenCalledOnce()
    expect(window.destroyed).toBe(false)
    expect(hasActiveWork).not.toHaveBeenCalled()
  })

  it("retains a host on query failure and coalesces repeated close clicks", async () => {
    const window = new WindowStub()
    let reject!: (reason: Error) => void
    const hasActiveWork = vi.fn(() => new Promise<boolean>((_resolve, rejectPromise) => { reject = rejectPromise }))
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => true, quitState: () => "running" })
    window.close(); window.close()
    await vi.waitFor(() => expect(hasActiveWork).toHaveBeenCalledOnce())
    reject(new Error("SDK offline"))
    await vi.waitFor(() => expect(window.hide).toHaveBeenCalledOnce())
    expect(window.destroyed).toBe(false)
  })

  it("does not intercept an explicit application quit", () => {
    const window = new WindowStub()
    const hasActiveWork = vi.fn(async () => true)
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => true, quitState: () => "ready" })
    const event = window.close()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.destroyed).toBe(true)
    expect(hasActiveWork).not.toHaveBeenCalled()
  })
})

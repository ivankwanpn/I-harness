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
  it("hides active work with a tray and keeps the window alive", async () => {
    const window = new WindowStub()
    const hasActiveWork = vi.fn(async () => true)
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => true, isQuitting: () => false })
    const first = window.close()
    expect(first.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(window.hide).toHaveBeenCalledOnce())
    expect(window.destroyed).toBe(false)
    expect(window.minimize).not.toHaveBeenCalled()
  })

  it("minimizes active work when tray creation failed", async () => {
    const window = new WindowStub()
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork: async () => true, trayAvailable: () => false, isQuitting: () => false })
    window.close()
    await vi.waitFor(() => expect(window.minimize).toHaveBeenCalledOnce())
    expect(window.hide).not.toHaveBeenCalled()
    expect(window.destroyed).toBe(false)
  })

  it("allows the second close event for an idle workspace", async () => {
    const window = new WindowStub()
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork: async () => false, trayAvailable: () => true, isQuitting: () => false })
    window.close()
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledTimes(2))
    expect(window.destroyed).toBe(true)
    expect(window.hide).not.toHaveBeenCalled()
  })

  it("retains a host on query failure and coalesces repeated close clicks", async () => {
    const window = new WindowStub()
    let reject!: (reason: Error) => void
    const hasActiveWork = vi.fn(() => new Promise<boolean>((_resolve, rejectPromise) => { reject = rejectPromise }))
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => true, isQuitting: () => false })
    window.close(); window.close()
    await vi.waitFor(() => expect(hasActiveWork).toHaveBeenCalledOnce())
    reject(new Error("SDK offline"))
    await vi.waitFor(() => expect(window.hide).toHaveBeenCalledOnce())
    expect(window.destroyed).toBe(false)
  })

  it("does not intercept an explicit application quit", () => {
    const window = new WindowStub()
    const hasActiveWork = vi.fn(async () => true)
    attachCloseLifecycle(window as unknown as BrowserWindow, { hasActiveWork, trayAvailable: () => true, isQuitting: () => true })
    const event = window.close()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.destroyed).toBe(true)
    expect(hasActiveWork).not.toHaveBeenCalled()
  })
})

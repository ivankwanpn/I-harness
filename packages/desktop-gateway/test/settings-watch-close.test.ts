import { beforeEach, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { SettingsWatchHandle } from "@i-harness/settings"

const observed = vi.hoisted(() => ({
  watcher: undefined as SettingsWatchHandle | undefined,
  trigger: undefined as (() => void | Promise<void>) | undefined,
  events: [] as string[],
  releaseRefresh: undefined as (() => void) | undefined,
  refreshStarted: false,
  holdRefresh: false,
  initialRefreshDone: false,
  releaseClose: undefined as (() => void) | undefined,
  holdClose: false,
  failClose: false,
}))
vi.mock("@i-harness/settings", async importOriginal => {
  const actual = await importOriginal<typeof import("@i-harness/settings")>()
  return { ...actual, watchSettings(paths: string | string[], callback: () => void | Promise<void>) {
    observed.trigger = callback
    const watcher = actual.watchSettings(paths, callback)
    observed.watcher = { ...watcher,
      dispose() { observed.events.push("fence"); watcher.dispose() },
      async close() {
        observed.events.push("join")
        if (observed.failClose) { observed.failClose = false; throw new Error("controlled cleanup failure") }
        if (observed.holdClose) await new Promise<void>(resolve => { observed.releaseClose = resolve })
        await watcher.close()
      },
    }
    return observed.watcher
  } }
})
// Keep actual host/MCP/plugin composition. Hold only the dependent session
// refresh boundary; it can settle only once host shutdown reaches service.close.
vi.mock("@i-harness/session-executor", async importOriginal => {
  const actual = await importOriginal<typeof import("@i-harness/session-executor")>()
  return { ...actual, createSessionService(...args: Parameters<typeof actual.createSessionService>) {
    const service = actual.createSessionService(...args)
    return { ...service,
      async refreshExtensions() {
        if (!observed.holdRefresh) { await service.refreshExtensions(); observed.initialRefreshDone = true; return }
        observed.refreshStarted = true
        await new Promise<void>(resolve => { observed.releaseRefresh = resolve })
      },
      async close() { observed.events.push("service"); observed.releaseRefresh?.(); await service.close() },
    }
  } }
})
import { createDesktopHost } from "../src/host.ts"

beforeEach(() => { observed.events = []; observed.refreshStarted = false; observed.holdRefresh = false; observed.initialRefreshDone = false; observed.holdClose = false; observed.failClose = false; observed.releaseClose = undefined; observed.releaseRefresh = undefined })
async function fixture() {
  const parent = resolve(process.cwd(), ".tmp"); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "settings-watch-close-")), workspace = join(root, "workspace"), sessionDir = join(root, "sessions"), settingsPath = join(root, "settings.json")
  await mkdir(workspace); await mkdir(sessionDir); await writeFile(settingsPath, '{"sandboxMode":"danger-full-access"}')
  return { root, workspace, sessionDir, settingsPath }
}

it("returns the trust refresh promise, fences early, and joins after dependent cleanup", async () => {
  const f = await fixture(), host = await createDesktopHost({ ...f, onWrite() {} })
  let closing: Promise<void> | undefined
  try {
    await vi.waitFor(() => expect(observed.initialRefreshDone).toBe(true))
    observed.holdRefresh = true
    const refresh = observed.trigger!()
    expect(refresh).toBeInstanceOf(Promise)
    await vi.waitFor(() => expect(observed.refreshStarted).toBe(true))
    observed.holdClose = true; closing = host.close()
    await vi.waitFor(() => expect(observed.releaseClose).toBeTypeOf("function"))
    expect(observed.events).toEqual(["fence", "service", "join"])
    let done = false; void closing.then(() => { done = true }); await Promise.resolve(); expect(done).toBe(false)
    observed.releaseClose!(); await closing; await refresh
  } finally { observed.releaseRefresh?.(); observed.releaseClose?.(); await (closing ?? host.close()); await rm(f.root, { recursive: true, force: true }) }
})

it("retains a failed watcher close for a later host close attempt", async () => {
  const f = await fixture(), host = await createDesktopHost({ ...f, onWrite() {} })
  try {
    observed.failClose = true
    await expect(host.close()).rejects.toBeInstanceOf(AggregateError)
    await host.close()
    expect(observed.events).toEqual(["fence", "service", "join", "join"])
  } finally { await host.close(); await rm(f.root, { recursive: true, force: true }) }
})

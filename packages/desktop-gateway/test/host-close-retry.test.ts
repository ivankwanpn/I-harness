import { beforeEach, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { encodeFrame, makeRequest } from "@i-harness/sdk"

const observed = vi.hoisted(() => ({ terminalClose: vi.fn(async () => {}), pluginsClose: vi.fn(), causal: false,
  service: undefined as import("@i-harness/session-executor").SessionService | undefined,
  plugins: undefined as ReturnType<typeof import("../src/plugins.ts").createDesktopPlugins> | undefined,
  holdAssembly: undefined as Promise<void> | undefined, assemblyEntered: vi.fn(), refreshEntered: vi.fn(),
  leaseClose: vi.fn(), sharedClose: vi.fn(), acquirePlugin: vi.fn(), allowLeaseClose: false,
  late: undefined as (() => void) | undefined, detached: false,
  detachFailure: undefined as Error | undefined,
}))
vi.mock("@i-harness/session-executor", async importOriginal => {
  const actual = await importOriginal<typeof import("@i-harness/session-executor")>()
  return { ...actual, createSessionService(options: Parameters<typeof actual.createSessionService>[0]) {
    if (!observed.causal) return actual.createSessionService(options)
    const service = actual.createSessionService({ ...options, modelPolicy: "test-mock", modelBindingFor: undefined,
      extensionsFor: async id => { observed.assemblyEntered(); await observed.holdAssembly; return options.extensionsFor!(id) },
    })
    const refresh = service.refreshExtensions.bind(service)
    service.refreshExtensions = () => { observed.refreshEntered(); return refresh() }
    observed.service = service
    return service
  } }
})
vi.mock("@i-harness/fs-watch", async importOriginal => {
  const actual = await importOriginal<typeof import("@i-harness/fs-watch")>()
  return { ...actual, createFsWatchService: (...args: Parameters<typeof actual.createFsWatchService>) => {
    const service = actual.createFsWatchService(...args)
    if (!observed.causal) return service
    return { acquire(options: Parameters<typeof service.acquire>[0]) {
      const lease = service.acquire(options)
      if (!options.roots.some(root => /plugins[\\/]state\.json$/.test(root))) return lease
      observed.acquirePlugin()
      return { ready: lease.ready, subscribe(listener: Parameters<typeof lease.subscribe>[0]) {
        observed.late = () => listener({ kind: "reset", reason: "recovered", cursor: { epoch: 2, revision: 1 } })
        const detach = lease.subscribe(listener)
        return () => { observed.detached = true; detach(); if (observed.detachFailure) { const error = observed.detachFailure; observed.detachFailure = undefined; throw error } }
      }, close: async () => { observed.leaseClose(); if (!observed.allowLeaseClose) throw new Error("plugin lease held cleanup"); await lease.close() } }
    }, close: async () => { observed.sharedClose(); await service.close() } }
  } }
})
vi.mock("../src/terminal.ts", () => ({ createDesktopTerminal: () => ({ request: async () => [], close: observed.terminalClose }) }))
vi.mock("../src/plugins.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/plugins.ts")>()
  return { ...actual, createDesktopPlugins: (...args: Parameters<typeof actual.createDesktopPlugins>) => {
    const plugins = actual.createDesktopPlugins(...args)
    if (observed.causal) observed.plugins = plugins
    return { ...plugins, async close() { observed.pluginsClose(); await plugins.close() } }
  } }
})

import { createDesktopHost } from "../src/host.ts"

beforeEach(() => { vi.clearAllMocks(); observed.causal = false; observed.detached = false; observed.allowLeaseClose = false; observed.terminalClose.mockImplementation(async () => {}) })

function fixture() {
  const ownedRoot = resolve(process.cwd(), ".tmp")
  mkdirSync(ownedRoot, { recursive: true })
  const root = mkdtempSync(join(ownedRoot, "sandbox-redesign-host-retry-"))
  const workspace = join(root, "workspace")
  const sessionDir = join(root, "sessions")
  const settingsPath = join(root, "settings.json")
  mkdirSync(workspace); mkdirSync(sessionDir)
  writeFileSync(settingsPath, JSON.stringify({ sandboxMode: "danger-full-access" }))
  return { root, ownedRoot, workspace, sessionDir, settingsPath }
}

function cleanup(f: ReturnType<typeof fixture>): void {
  if (!existsSync(f.root)) return
  const parent = realpathSync.native(f.ownedRoot)
  const actual = realpathSync.native(f.root)
  if (!actual.startsWith(parent + sep)) throw new Error("Host fixture cleanup escaped workspace .tmp")
  rmSync(actual, { recursive: true, force: true })
}

it("retries failed terminal cleanup, closes unrelated services and does not reopen admissions", async () => {
  const f = fixture()
  const host = await createDesktopHost({ ...f, onWrite: () => {} })
  const failure = new Error("native terminal cleanup incomplete")
  observed.terminalClose.mockRejectedValueOnce(failure)
  const first = await host.close().then(() => undefined, error => error)
  const afterFirst = { terminalCalls: observed.terminalClose.mock.calls.length, pluginCalls: observed.pluginsClose.mock.calls.length }
  const admission = await host.handleLine(encodeFrame(makeRequest(1, "initialize", {}))).then(() => "accepted", () => "closed")
  const second = await host.close().then(() => "closed", () => "failed")
  if (second === "closed") cleanup(f)
  expect(first).toBeInstanceOf(AggregateError)
  expect((first as AggregateError).errors).toContain(failure)
  expect(afterFirst).toEqual({ terminalCalls: 1, pluginCalls: 1 })
  expect(admission).toBe("closed")
  expect(second).toBe("closed")
  expect(observed.terminalClose).toHaveBeenCalledTimes(2)
  expect(observed.pluginsClose).toHaveBeenCalledTimes(1)
})

it("keeps an undefined terminal close rejection as a failure and retries it", async () => {
  const f = fixture()
  const host = await createDesktopHost({ ...f, onWrite: () => {} })
  observed.terminalClose.mockRejectedValueOnce(undefined)
  const first = await host.close().then(() => "success", error => error)
  const second = await host.close().then(() => "closed", () => "failed")
  if (second === "closed") cleanup(f)
  expect(first).toBeInstanceOf(AggregateError)
  expect((first as AggregateError).errors).toContain(undefined)
  expect(second).toBe("closed")
  expect(observed.terminalClose).toHaveBeenCalledTimes(2)
})

it("fences host observers before joining held real refresh and retries the same failed plugin lease", async () => {
  observed.causal = true
  const f = fixture()
  const host = await createDesktopHost({ ...f, onWrite: () => {} })
  await vi.waitFor(() => expect(observed.refreshEntered).toHaveBeenCalled())
  await new Promise(resolve => setImmediate(resolve))
  let release!: () => void
  observed.holdAssembly = new Promise<void>(resolve => { release = resolve })
  const assembly = observed.service!.assemblyFor("held-host-assembly").then(() => undefined, () => undefined)
  await vi.waitFor(() => expect(observed.assemblyEntered).toHaveBeenCalled())
  const before = observed.refreshEntered.mock.calls.length
  observed.late!()
  await vi.waitFor(() => expect(observed.refreshEntered.mock.calls.length).toBeGreaterThan(before))
  let settled = false
  const closing = host.close().then(() => undefined, error => error).finally(() => { settled = true })
  expect(observed.detached).toBe(true)
  await expect(host.handleLine(encodeFrame(makeRequest(1, "initialize", {})))).rejects.toThrow("closing")
  await vi.waitFor(() => expect(observed.terminalClose).toHaveBeenCalled())
  const refreshes = observed.refreshEntered.mock.calls.length
  observed.late!()
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(observed.refreshEntered).toHaveBeenCalledTimes(refreshes)
  release(); await assembly
  expect(await closing).toBeInstanceOf(AggregateError)
  expect(observed.leaseClose.mock.calls.length).toBeGreaterThan(0)
  expect(observed.sharedClose).not.toHaveBeenCalled()
  expect(observed.acquirePlugin).toHaveBeenCalledTimes(1)
  observed.allowLeaseClose = true
  await host.close()
  expect(observed.sharedClose).toHaveBeenCalledTimes(1)
  expect(observed.acquirePlugin).toHaveBeenCalledTimes(1)
  observed.late!(); await new Promise(resolve => setImmediate(resolve))
  expect(observed.refreshEntered).toHaveBeenCalledTimes(refreshes)
  observed.holdAssembly = undefined
  cleanup(f)
})

it("collects a throwing early plugin fence and still attempts independent host cleanup", async () => {
  observed.causal = true; observed.allowLeaseClose = true
  const f = fixture()
  const host = await createDesktopHost({ ...f, onWrite: () => {} })
  const failure = new Error("early detach failure")
  observed.detachFailure = failure
  const closing = host.close()
  await expect(host.handleLine(encodeFrame(makeRequest(1, "initialize", {})))).rejects.toThrow("closing")
  const error = await closing.then(() => undefined, error => error) as AggregateError
  expect(error.errors).toContain(failure)
  expect(observed.terminalClose).toHaveBeenCalledTimes(1)
  expect(observed.pluginsClose).toHaveBeenCalledTimes(1)
  await host.close(); cleanup(f)
})

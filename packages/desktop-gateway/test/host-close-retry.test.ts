import { beforeEach, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { encodeFrame, makeRequest } from "@i-harness/sdk"

const observed = vi.hoisted(() => ({ terminalClose: vi.fn(async () => {}), pluginsClose: vi.fn() }))
vi.mock("../src/terminal.ts", () => ({ createDesktopTerminal: () => ({ request: async () => [], close: observed.terminalClose }) }))
vi.mock("../src/plugins.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/plugins.ts")>()
  return { ...actual, createDesktopPlugins: (...args: Parameters<typeof actual.createDesktopPlugins>) => {
    const plugins = actual.createDesktopPlugins(...args)
    return { ...plugins, async close() { observed.pluginsClose(); await plugins.close() } }
  } }
})

import { createDesktopHost } from "../src/host.ts"

beforeEach(() => { vi.clearAllMocks(); observed.terminalClose.mockImplementation(async () => {}) })

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

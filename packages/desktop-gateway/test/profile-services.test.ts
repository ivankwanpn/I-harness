import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import { createDesktopProfileServices, createConfigurationHost } from "../src/configuration-host.ts"

it("manages shared extensions without opening a workspace or exposing a workspace resource layer", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-profile-extensions-"))
  const profile = createDesktopProfileServices(join(root, "settings.json"))
  const frames: RpcMessage[] = []
  const settings = await createConfigurationHost(profile, frame => frames.push(frame))
  let id = 0
  async function call(method: string, params: unknown = {}) {
    const requestId = ++id
    await settings.handleLine(encodeFrame(makeRequest(requestId, method, params)))
    const reply = frames.find(frame => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try {
    await call("initialize")
    const list = () => call("desktop/resources/list", { resourceKind: "commands", query: "", offset: 0, includeShadowed: true })
    const newCommand = { resourceKind: "commands", name: "hello", body: "Shared command", expectedRevision: null }
    await expect(call("desktop/resources/write", { ...newCommand, source: "workspace" })).rejects.toThrow(/requires a workspace/)
    const listener = vi.fn(async () => {})
    const unsubscribe = profile.onResourceChange(listener)
    await call("desktop/resources/write", { ...newCommand, source: "global" })
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    expect(await list()).toMatchObject({ items: [{ name: "hello", source: "global", effective: true }], total: 1 })
    const source = fileURLToPath(new URL("../../plugin-registry/test/fixtures/marketplace-a", import.meta.url))
    const id = "Marketplace A__hello"
    await call("desktop/plugins/mutate", { action: "source/add", source })
    await call("desktop/plugins/mutate", { action: "install", id })
    expect(await list()).toMatchObject({ items: [{ source: "global", effective: true }], total: 1 })
    await call("desktop/plugins/mutate", { action: "enable", id })
    expect(await list()).toMatchObject({ items: [
      { name: "hello", source: "global", effective: false }, { name: "hello", source: "plugin", effective: true },
    ], total: 2 })
    await call("desktop/plugins/mutate", { action: "disable", id })
    expect(await list()).toMatchObject({ items: [{ source: "global", effective: true }], total: 1 })
    await call("desktop/plugins/mutate", { action: "uninstall", id })
    await call("desktop/plugins/mutate", { action: "source/remove", name: "Marketplace A" })
    expect(await call("desktop/plugins/state")).toMatchObject({ sources: [], plugins: [] })
    await expect(call("session/list")).rejects.toThrow(/Unknown configuration method/)
  } finally {
    await settings.close()
    await profile.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("retains process-owned account/login services across workspace and settings channel closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-host-profile-"))
  const settingsPath = join(root, "settings.json")
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sessionStore: "jsonl" }))
  const profile = createDesktopProfileServices(settingsPath)
  const close = vi.spyOn(profile.accounts, "close")
  const frames: RpcMessage[] = []
  const settings = await createConfigurationHost(profile, frame => frames.push(frame))
  const workspace = await createDesktopHost({ workspace: root, sessionDir: join(root, "sessions"), profile, onWrite() {} })
  try {
    await settings.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
    await workspace.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
    const login = vi.spyOn(profile.accounts, "hasActiveLogin").mockReturnValue(true)
    expect(workspace.hasActiveWork?.()).toBe(false)
    expect(settings.hasActiveWork?.()).toBe(false)
    await workspace.close()
    expect(close).not.toHaveBeenCalled()
    await settings.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "desktop/runtime/activity", params: {} }))
    expect(frames.at(-1)).toMatchObject({ id: 2, result: { active: true } })
    login.mockReturnValue(false)
    await settings.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "desktop/runtime/activity", params: {} }))
    expect(frames.at(-1)).toMatchObject({ id: 3, result: { active: false } })
    await settings.close()
    expect(close).not.toHaveBeenCalled()
  } finally {
    await workspace.close()
    await settings.close()
    await profile.close()
    await rm(root, { recursive: true, force: true })
  }
  expect(close).toHaveBeenCalledOnce()
})

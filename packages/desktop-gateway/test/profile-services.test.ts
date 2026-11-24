import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import { createDesktopProfileServices, createConfigurationHost } from "../src/configuration-host.ts"

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
    const login = vi.spyOn(profile.accounts, "hasActiveLogin").mockReturnValue(true)
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

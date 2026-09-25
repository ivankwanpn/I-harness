import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(mode: "read-only" | "workspace-write" | "danger-full-access") {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-host-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const sessionDir = join(root, "sessions")
  const settingsPath = join(root, "settings.json")
  mkdirSync(workspace)
  mkdirSync(sessionDir)
  writeFileSync(settingsPath, JSON.stringify({ sandboxMode: mode }), "utf8")
  const frames: RpcMessage[] = []
  return { root, workspace, sessionDir, settingsPath, frames }
}

describe("Desktop host sandbox configuration", () => {
  it("loads settings before reporting the wired read-only mode", async () => {
    const f = fixture("read-only")
    const host = await createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })
    try {
      await host.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      await host.handleLine(encodeFrame(makeRequest(2, "desktop/sandbox/state", {})))
      const reply = f.frames.find((frame) => "id" in frame && frame.id === 2)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("sandbox state missing")
      expect(reply.result).toEqual({ mode: "read-only", source: "settings", wired: true })
    } finally { await host.close() }
  })

  it("uses the operator's workspace-write setting, not an implicit default", async () => {
    const f = fixture("workspace-write")
    const host = await createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })
    try {
      await host.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      await host.handleLine(encodeFrame(makeRequest(2, "desktop/sandbox/state", {})))
      const reply = f.frames.find((frame) => "id" in frame && frame.id === 2)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("sandbox state missing")
      expect(reply.result).toEqual({ mode: "workspace-write", source: "settings", wired: true })
    } finally { await host.close() }
  })

  it("refuses corrupt settings instead of reporting a default as configured", async () => {
    const f = fixture("read-only")
    writeFileSync(f.settingsPath, "{invalid", "utf8")
    await expect(createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })).rejects.toThrow(/invalid settings/i)
  })
})

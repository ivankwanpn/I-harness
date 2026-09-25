import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFrame, INVALID_PARAMS, isRpcFailure, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

describe("Desktop review methods share the SDK-compatible connection", () => {
  it("advertises review only when wired and serves bounded workspace data", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-desktop-review-wire-"))
    const workspace = join(root, "workspace")
    const sessionDir = join(root, "sessions")
    mkdirSync(workspace)
    mkdirSync(sessionDir)
    execFileSync("git", ["init", "-q"], { cwd: workspace })
    execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: workspace })
    execFileSync("git", ["config", "user.name", "Review Test"], { cwd: workspace })
    writeFileSync(join(workspace, "tracked.txt"), "before\n", "utf8")
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace })
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: workspace })
    writeFileSync(join(workspace, "tracked.txt"), "after\n", "utf8")
    const settingsPath = join(root, "settings.json")
    writeFileSync(settingsPath, JSON.stringify({ sandboxMode: "read-only" }), "utf8")
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: (frame) => { frames.push(frame) } })
    async function reply(id: number, method: string, params: unknown) {
      await host.handleLine(encodeFrame(makeRequest(id, method, params)))
      return frames.find((frame) => "id" in frame && frame.id === id)
    }
    try {
      const init = await reply(1, "initialize", {})
      expect(isRpcSuccess(init)).toBe(true)
      if (!isRpcSuccess(init)) throw new Error("initialize failed")
      expect((init.result as { capabilities: Record<string, string[]> }).capabilities["desktop-review"]).toEqual(["1"])
      const changes = await reply(2, "desktop/review/changes", {})
      expect(isRpcSuccess(changes)).toBe(true)
      if (!isRpcSuccess(changes)) throw new Error("changes failed")
      expect(changes.result).toMatchObject({ kind: "ok", files: [expect.objectContaining({ path: "tracked.txt" })] })
      const diff = await reply(3, "desktop/review/diff", { path: "tracked.txt" })
      expect(isRpcSuccess(diff)).toBe(true)
      if (!isRpcSuccess(diff)) throw new Error("diff failed")
      expect((diff.result as { text: string }).text).toContain("+after")
      const file = await reply(4, "desktop/review/file", { path: "tracked.txt" })
      expect(isRpcSuccess(file)).toBe(true)
      if (!isRpcSuccess(file)) throw new Error("file failed")
      expect(file.result).toMatchObject({ kind: "text", text: "after\n" })
      const invalid = await reply(5, "desktop/review/file", { path: "../outside.txt" })
      expect(isRpcFailure(invalid)).toBe(true)
      if (!isRpcFailure(invalid)) throw new Error("invalid path was accepted")
      expect(invalid.error.code).toBe(INVALID_PARAMS)
    } finally {
      await host.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

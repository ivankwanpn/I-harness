// M27 R-C4c: REAL subprocess end-to-end — `i-harness sdk` spawned via
// node --import tsx, driven by HarnessClient over stdio, with the default mock
// model. Windows CI compatible (spawn + pipes; same tsx-loader precedent as
// e2e/helpers.ts).
import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHarnessClient } from "../src/client.ts"
import type { ServerInfo } from "../src/client.ts"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
// Absolute file URL of tsx's loader entry — resolves from ANY cwd (the e2e
// workspace lives under the OS temp root; see e2e/helpers.ts note).
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts")

async function waitForFile(path: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

describe("i-harness sdk end-to-end (real subprocess)", () => {
  it(
    "spawns the real CLI server, initializes, runs a prompt and streams the turn events",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-e2e-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-e2e-sess-"))
      const client = createHarnessClient({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir],
        cwd: workspace,
      })
      try {
        // handshake: the server answers initialize — v1: protocolVersion 2 and
        // the two additive capability rows
        const info = (await client.request("initialize", {})) as ServerInfo
        expect(info.name).toBe("i-harness")
        expect(info.protocolVersion).toBe(2)
        expect(info.capabilities["session-history"]).toEqual(["1"])
        expect(info.capabilities["session-list"]).toEqual(["1"])

        // high-level run through the real engine (mock model default)
        const result = await client.run({ sessionId: "sdk-e2e-1", prompt: "hello" })
        expect(result.sessionId).toBe("sdk-e2e-1")
        const types = result.events.map((e) => e.type)
        expect(types).toContain("turn/start")
        expect(types).toContain("user/message")
        expect(types).toContain("assistant/message")
        expect(types).toContain("turn/end")
        expect(result.text).toContain("ok")

        // the session was created + persisted under --session-dir
        const sessionFile = join(sessionDir, "sdk-e2e-1.jsonl")
        expect(await waitForFile(sessionFile)).toBe(true)

        // status surface after the run
        const state = await client.status("sdk-e2e-1")
        expect(state).toEqual({ running: false, queued: 0 })

        // M41a v1: session/history returns REAL data over the live log (the
        // turn events above, in seq order) and session/list is served by the
        // CLI's coordinator-backed source (--session-dir given).
        const range = await client.history("sdk-e2e-1")
        expect(range.events.length).toBeGreaterThan(0)
        expect(range.events.map((e) => e.type)).toContain("turn/end")
        expect(range.nextSeq).toBe(range.events.length)
        const list = await client.listSessions()
        expect(list.listingUnavailable).toBeUndefined()
        expect(list.sessions.map((s) => s.id)).toContain("sdk-e2e-1")
      } finally {
        await client.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

// M41b v1.1: REAL-subprocess e2e of the v1.1 appendix — `i-harness sdk`
// spawned via node --import tsx, driven by HarnessClient over stdio:
// initialize capability rows, session/list enrichment (updatedAt/turnCount
// over a real store), session/cancel honest answers, and the session/rewind
// round trip through the CLI's rewindFactory (embedded-bridge pattern) with a
// PRE-SEEDED rewind point (the subprocess's default mock turn never writes a
// file, so the durable rewind fixture is written by THIS test via
// @i-harness/rewind's RewindStore — the same store root the CLI wires).
import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHarnessClient } from "@i-harness/sdk"
import { RewindStore, sha256Hex } from "@i-harness/rewind"
import type { CancelResult, RewindPointsResponse, RewindPlanResponse, RewindExecuteResponse } from "@i-harness/sdk"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts")

describe("i-harness sdk wire v1.1 end-to-end (real subprocess)", () => {
  it(
    "cancel + rewind/* + enriched list rows over the real CLI server",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "ih-sdk-w11-ws-"))
      const sessionDir = mkdtempSync(join(tmpdir(), "ih-sdk-w11-sess-"))
      // workspace fixture: a file the seeded rewind point "created" in turn 0
      const aPath = join(workspace, "a.txt")
      writeFileSync(aPath, "hello")
      // the durable rewind fixture — the same store layout the CLI wires
      // (rewindStoreRoot = the session dir → <dir>/rewind/<sessionId>/…)
      const store = new RewindStore({ root: sessionDir, sessionId: "sdk-w11" })
      await store.appendPoint({
        turnIndex: 0,
        anchorSeq: 0,
        promptPreview: "seeded",
        files: [{ path: "a.txt", status: "added", isNewFile: true, afterHash: sha256Hex(new TextEncoder().encode("hello")) }],
      })

      const client = createHarnessClient({
        command: process.execPath,
        args: ["--import", TSX_LOADER, CLI_ENTRY, "sdk", "--session-dir", sessionDir],
        cwd: workspace,
      })
      try {
        // handshake: v1.1 capability rows (protocolVersion stays 2)
        const info = (await client.request("initialize", {})) as {
          protocolVersion: number
          capabilities: Record<string, string[]>
        }
        expect(info.protocolVersion).toBe(2)
        expect(info.capabilities["session-cancel"]).toEqual(["1"])
        expect(info.capabilities["session-rewind"]).toEqual(["1"])

        // one turn → the live assembly (the rewind factory resolves it)
        const result = await client.run({ sessionId: "sdk-w11", prompt: "hello" })
        expect(result.text).toContain("ok")

        // cancel: honest answers — unknown ("ghost") → not-found; the run
        // session is known + idle → not-running
        expect(await client.cancel("ghost")).toEqual<CancelResult>({ cancelled: false, reason: "not-found" })
        expect(await client.cancel("sdk-w11")).toEqual<CancelResult>({ cancelled: false, reason: "not-running" })

        // list enrichment: the row carries updatedAt + turnCount (the store
        // has real events + a real artifact mtime)
        const list = await client.listSessions()
        expect(list.listingUnavailable).toBeUndefined()
        const row = list.sessions.find((s) => s.id === "sdk-w11")
        expect(row).toBeDefined()
        expect(row!.updatedAt).toBeTypeOf("number")
        expect(row!.turnCount).toBeTypeOf("number")
        expect(row!.turnCount).toBeGreaterThanOrEqual(1)

        // rewind round trip via the wire — the factory serves the durable
        // points (pre-seeded turn 0) plus whatever the mock turn recorded
        const points = await client.rewindPoints("sdk-w11")
        expect<RewindPointsResponse>(points).toEqual({
          points: expect.arrayContaining([{ turnIndex: 0, preview: "seeded", files: 1 }]),
        })

        // plan: the seeded point's file is on the disk still matching its
        // afterHash → clean (delete-added restore); conversation mode → no ops
        const plan = await client.rewindPlan("sdk-w11", 0, "conversation")
        expect<RewindPlanResponse>(plan).toMatchObject({
          clean: [{ path: "a.txt", op: "delete-added" }],
          conflicts: [],
          unTracked: [],
          ops: [],
        })

        // execute (files mode): deletes the created file + appends the
        // rewind/point marker into the live session log (history sees it)
        const executed = await client.rewindExecute("sdk-w11", 0, "files")
        expect<RewindExecuteResponse>(executed).toMatchObject({ revertedFiles: 1, conflicts: [] })
        expect(existsSync(aPath)).toBe(false)
        const range = await client.history("sdk-w11")
        expect(range.events.map((e) => e.type)).toContain("rewind/point")
      } finally {
        await client.close().catch(() => {})
        rmSync(workspace, { recursive: true, force: true })
        rmSync(sessionDir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

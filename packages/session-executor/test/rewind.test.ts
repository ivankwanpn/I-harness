// M42 G1 integration: assembly-wired rewind — a scripted turn runs a REAL fs
// write tool, the event chain (user/message → tool call/result → turn/end)
// drives the recorder, and the durable point lands in the rewind store; then
// the engine executes a rewind through the same store.
import { describe, expect, it, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { append } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { RewindService } from "@i-harness/rewind"
import { createSessionAssembly } from "../src/assembly.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)
const H = (s: string) => createHash("sha256").update(utf8(s)).digest("hex")

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("timeout waiting for rewind point")
}

describe("assembly rewind wiring", () => {
  const cleanup: string[] = []
  afterEach(() => {
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("records a point for a scripted turn that ran an fs write, then executes a rewind", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-rewind-ws-"))
    const storeRoot = mkdtempSync(join(tmpdir(), "i-harness-rewind-store-"))
    cleanup.push(workspace, storeRoot)
    await writeFile(join(workspace, "greet.txt"), "hello")

    const assembly = await createSessionAssembly({
      workspace,
      sessionId: "r1",
      rewindStoreRoot: storeRoot,
      // one scripted turn: write greet.txt → final assistant message
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "write", args: { path: "greet.txt", text: "goodbye" } }] },
        { role: "assistant", text: "done" },
      ]),
    })
    try {
      expect(assembly.rewind).toBeDefined()
      const store = assembly.rewind!.store

      await assembly.agent.run("rewrite it")
      // finalize is detached (async) — wait for the durable point
      await waitFor(async () => (await store.readPoints()).length === 1)
      const points = await store.readPoints()
      expect(points[0]!.turnIndex).toBe(0)
      expect(points[0]!.anchorSeq).toBeGreaterThanOrEqual(0)
      expect(points[0]!.promptPreview).toBe("rewrite it")
      expect(points[0]!.files).toContainEqual({
        path: "greet.txt",
        status: "modified",
        preBlob: H("hello"),
        isNewFile: false,
        afterHash: H("goodbye"),
      })

      // the tool RESULT carried the pre-image ref (the log is the channel)
      const toolRes = assembly.session.events.find((e) => e.type === "tool/result") as {
        output: { preImageRef?: string; isNewFile?: boolean }
      }
      expect(toolRes.output.preImageRef).toBe(H("hello"))
      expect(toolRes.output.isNewFile).toBe(false)

      // rewind through the engine: restore file + append the rewind/point
      // event + truncate the journal
      const service = new RewindService({ store, workspace })
      const result = await service.execute(0, "all", { appendEvent: (ev) => append(assembly.session, ev) })
      expect(result.truncated).toBe(true)
      expect(result.errors).toEqual([])
      expect(await readFile(join(workspace, "greet.txt"), "utf-8")).toBe("hello")
      const rewindEv = assembly.session.events.find((e) => e.type === "rewind/point") as { targetTurn: number; fileOps: Array<{ path: string; op: string }> }
      expect(rewindEv).toBeDefined()
      expect(rewindEv.fileOps).toEqual([{ path: "greet.txt", op: "restore" }])
      expect(await store.readPoints()).toEqual([])
    } finally {
      await assembly.dispose()
    }
  }, 60_000)

  it("no rewind handle when rewindStoreRoot is absent (off by default)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-rewind-ws2-"))
    cleanup.push(workspace)
    const assembly = await createSessionAssembly({ workspace, sessionId: "n1" })
    try {
      expect(assembly.rewind).toBeUndefined()
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("no rewind handle when sessionId is absent (storage requires a key)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-rewind-ws3-"))
    const storeRoot = mkdtempSync(join(tmpdir(), "i-harness-rewind-store3-"))
    cleanup.push(workspace, storeRoot)
    const assembly = await createSessionAssembly({ workspace, rewindStoreRoot: storeRoot })
    try {
      expect(assembly.rewind).toBeUndefined()
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})

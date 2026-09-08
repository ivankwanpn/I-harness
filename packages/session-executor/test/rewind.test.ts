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
import { RewindRecorder } from "@i-harness/rewind"
import { RewindService } from "@i-harness/rewind"
import { RewindStore } from "@i-harness/rewind"
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
    const assembly = await createSessionAssembly({ workspace, sessionId: "n1", modelPolicy: "test-mock" })
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
    const assembly = await createSessionAssembly({ workspace, rewindStoreRoot: storeRoot, modelPolicy: "test-mock" })
    try {
      expect(assembly.rewind).toBeUndefined()
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("dispose waits for a pending rewind journal append", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-rewind-drain-ws-"))
    const storeRoot = mkdtempSync(join(tmpdir(), "i-harness-rewind-drain-store-"))
    cleanup.push(workspace, storeRoot)
    await writeFile(join(workspace, "greet.txt"), "before")
    const originalAppendPoint = RewindStore.prototype.appendPoint
    let appendEntered = false
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    RewindStore.prototype.appendPoint = async function (point) {
      appendEntered = true
      await gate
      return originalAppendPoint.call(this, point)
    }
    let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
    try {
      assembly = await createSessionAssembly({
        workspace,
        sessionId: "drain-1",
        rewindStoreRoot: storeRoot,
        model: createMockClient([
          { role: "assistant", toolCalls: [{ name: "write", args: { path: "greet.txt", text: "after" } }] },
          { role: "assistant", text: "done" },
        ]),
      })
      await assembly.agent.run("rewrite")
      await waitFor(async () => appendEntered)
      let closed = false
      const closing = assembly.dispose().then(() => { closed = true })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(closed).toBe(false)
      release()
      await closing
      expect(await assembly.rewind!.store.readPoints()).toHaveLength(1)
      assembly = undefined
    } finally {
      release()
      RewindStore.prototype.appendPoint = originalAppendPoint
      await assembly?.dispose()
    }
  }, 30_000)

  it("serializes consecutive rewind journal appends", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-rewind-serial-ws-"))
    const storeRoot = mkdtempSync(join(tmpdir(), "i-harness-rewind-serial-store-"))
    cleanup.push(workspace, storeRoot)
    await writeFile(join(workspace, "a.txt"), "a-before")
    await writeFile(join(workspace, "b.txt"), "b-before")
    const originalAppendPoint = RewindStore.prototype.appendPoint
    let appendCalls = 0
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    RewindStore.prototype.appendPoint = async function (point) {
      appendCalls++
      if (appendCalls === 1) await firstGate
      return originalAppendPoint.call(this, point)
    }
    let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
    try {
      assembly = await createSessionAssembly({
        workspace,
        sessionId: "serial-1",
        rewindStoreRoot: storeRoot,
        model: createMockClient([
          { role: "assistant", toolCalls: [{ name: "write", args: { path: "a.txt", text: "a-after" } }] },
          { role: "assistant", text: "first done" },
          { role: "assistant", toolCalls: [{ name: "write", args: { path: "b.txt", text: "b-after" } }] },
          { role: "assistant", text: "second done" },
        ]),
      })
      const store = assembly.rewind!.store
      await assembly.agent.run("first")
      await waitFor(async () => appendCalls === 1)
      await assembly.agent.run("second")
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(appendCalls).toBe(1)
      releaseFirst()
      await assembly.dispose()
      const points = await store.readPoints()
      expect(points).toHaveLength(2)
      expect(points.map((point) => point.turnIndex)).toEqual([0, 1])
      assembly = undefined
    } finally {
      releaseFirst()
      RewindStore.prototype.appendPoint = originalAppendPoint
      await assembly?.dispose()
    }
  }, 30_000)

  // M54 G2: a turn that crashed mid-flight (pre-images on disk, no finalize)
  // is archived at assembly open and reported honestly by plan().
  it("recovers a crashed pending turn at assembly open and surfaces it honestly", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "i-harness-rewind-crash-ws-"))
    const storeRoot = mkdtempSync(join(tmpdir(), "i-harness-rewind-crash-store-"))
    cleanup.push(workspace, storeRoot)
    await writeFile(join(workspace, "greet.txt"), "v1")
    // seed on disk (a "previous process"): one completed turn + one crash
    const seedStore = new RewindStore({ root: storeRoot, sessionId: "crash-1", workspace })
    const seedRec = new RewindRecorder({ store: seedStore, workspace })
    seedRec.begin(0, "first")
    seedRec.take("greet.txt", utf8("v0"))
    await writeFile(join(workspace, "greet.txt"), "v1")
    const first = (await seedRec.finalize())!
    await seedStore.appendPoint(first)
    await seedRec.commit(first.anchorSeq)
    seedRec.begin(10, "crash turn")
    seedRec.take("greet.txt", utf8("v1"))
    seedRec.take("orphan.txt", null)
    await seedRec.flush()
    await writeFile(join(workspace, "greet.txt"), "v2")

    const assembly = await createSessionAssembly({ workspace, sessionId: "crash-1", rewindStoreRoot: storeRoot, modelPolicy: "test-mock" })
    try {
      const store = assembly.rewind!.store
      // archived at open — never a fabricated point
      expect(await store.readPending()).toBeNull()
      expect((await store.readPoints()).map((p) => p.turnIndex)).toEqual([0])
      const orphans = await store.readOrphans()
      expect(orphans).toHaveLength(1)
      expect(orphans[0]!.anchorSeq).toBe(10)
      const svc = new RewindService({ store, workspace })
      const plan = await svc.plan(0)
      expect(plan.unTracked).toEqual(["orphan.txt"])
      expect(plan.orphanedTurns?.[0]).toMatchObject({ anchorSeq: 10, files: ["greet.txt", "orphan.txt"] })
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  // M54 G3: the journal is bound to its workspace — the session still opens
  // (the conversation is not the journal) but every rewind op fails closed.
  it("refuses rewind ops when the journal is bound to another workspace", async () => {
    const wsA = mkdtempSync(join(tmpdir(), "i-harness-rewind-bindA-"))
    const wsB = mkdtempSync(join(tmpdir(), "i-harness-rewind-bindB-"))
    const storeRoot = mkdtempSync(join(tmpdir(), "i-harness-rewind-bind-store-"))
    cleanup.push(wsA, wsB, storeRoot)
    const seed = new RewindStore({ root: storeRoot, sessionId: "ws-bind-1", workspace: wsA })
    await seed.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "A", files: [] })
    const assembly = await createSessionAssembly({ workspace: wsB, sessionId: "ws-bind-1", rewindStoreRoot: storeRoot, modelPolicy: "test-mock" })
    try {
      expect(assembly.rewind).toBeDefined() // the session itself still opens
      const svc = new RewindService({ store: assembly.rewind!.store, workspace: wsB })
      await expect(svc.points()).rejects.toMatchObject({ code: "REWIND_WORKSPACE_MISMATCH" })
      await expect(svc.plan(0)).rejects.toMatchObject({ code: "REWIND_WORKSPACE_MISMATCH" })
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})

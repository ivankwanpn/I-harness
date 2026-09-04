import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFile, mkdir } from "node:fs/promises"
import { RewindStore, RewindService, RewindError, RewindRecorder, sha256Hex } from "../src/index.ts"
import type { RewindEvent } from "../src/index.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)
const H = (s: string) => sha256Hex(utf8(s))

function record(path: string, opts: { status?: "added" | "modified" | "deleted"; preBlob?: string; isNewFile?: boolean; afterHash?: string } = {}) {
  return { path, status: opts.status ?? "modified", ...(opts.preBlob !== undefined ? { preBlob: opts.preBlob } : {}), ...(opts.isNewFile !== undefined ? { isNewFile: opts.isNewFile } : {}), ...(opts.afterHash !== undefined ? { afterHash: opts.afterHash } : {}) }
}

describe("RewindService", () => {
  let root: string
  let workspace: string
  let store: RewindStore
  let service: RewindService
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "i-harness-rewind-svc-"))
    workspace = join(root, "ws")
    await mkdir(workspace)
    store = new RewindStore({ root, sessionId: "s" })
    service = new RewindService({ store, workspace })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("points(): summaries in order", async () => {
    await store.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "p".repeat(200), files: [{ path: "x.txt", status: "modified", preBlob: "a".repeat(64) }] })
    await store.appendPoint({ turnIndex: 1, anchorSeq: 10, promptPreview: "second", files: [] })
    expect(await service.points()).toEqual([
      { turnIndex: 0, preview: "p".repeat(120), files: 1 },
      { turnIndex: 1, preview: "second", files: 0 },
    ])
  })

  it("plan: clean (current == afterHash) yields restore-blob op", async () => {
    const blob = await store.writeBlob(utf8("one"))
    await writeFile(join(workspace, "a.txt"), "two")
    await store.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "t0", files: [record("a.txt", { preBlob: blob, afterHash: H("two") })] })
    const plan = await service.plan(0)
    expect(plan.clean).toEqual([{ path: "a.txt", kind: "restore-blob", blobId: blob }])
    expect(plan.conflicts).toEqual([])
    expect(plan.unTracked).toEqual([])
    expect(plan.ops).toEqual([{ path: "a.txt", kind: "restore-blob", blobId: blob }])
  })

  it("plan: conflict modified / deleted / created (externally diverged)", async () => {
    const blob = await store.writeBlob(utf8("one"))
    await writeFile(join(workspace, "mod.txt"), "other-content")
    // gone.txt: NEVER written — current disk is missing → "deleted" conflict
    // born.txt: target end state absent (deleted in turn), recreated → created
    await writeFile(join(workspace, "born.txt"), "back-again")
    await store.appendPoint({
      turnIndex: 0, anchorSeq: 0, promptPreview: "t0",
      files: [
        record("mod.txt", { preBlob: blob, afterHash: H("two") }),
        record("gone.txt", { preBlob: blob, afterHash: H("two") }),
        record("born.txt", { preBlob: blob, afterHash: undefined, status: "deleted" }),
      ],
    })
    const plan = await service.plan(0)
    expect(plan.conflicts).toEqual([
      { path: "mod.txt", kind: "modified" },
      { path: "gone.txt", kind: "deleted" },
      { path: "born.txt", kind: "created" },
    ])
    // conflicts still get restore ops (grok: execute anyway, marked)
    expect(plan.ops).toHaveLength(3)
  })

  it("plan: added file clean → delete-added", async () => {
    await writeFile(join(workspace, "made.txt"), "hi")
    await store.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "t0", files: [record("made.txt", { status: "added", isNewFile: true, afterHash: H("hi") })] })
    const plan = await service.plan(0)
    expect(plan.clean).toEqual([{ path: "made.txt", kind: "delete-added" }])
  })

  it("plan: unTracked lists later-touched paths outside the target set", async () => {
    const blob = await store.writeBlob(utf8("one"))
    await writeFile(join(workspace, "a.txt"), "two")
    await writeFile(join(workspace, "later.txt"), "later-content")
    await store.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "t0", files: [record("a.txt", { preBlob: blob, afterHash: H("two") })] })
    await store.appendPoint({ turnIndex: 1, anchorSeq: 11, promptPreview: "t1", files: [record("a.txt", { preBlob: blob, afterHash: H("later2") }), record("later.txt", { isNewFile: true, status: "added", afterHash: H("later-content") })] })
    const plan = await service.plan(0)
    expect(plan.unTracked).toEqual(["later.txt"]) // a.txt is target's — a conflict, not unTracked
  })

  it("execute: restores blob + deletes added, appends event, truncates journal", async () => {
    const blob = await store.writeBlob(utf8("one"))
    await writeFile(join(workspace, "a.txt"), "two")
    await writeFile(join(workspace, "added.txt"), "created-in-turn")
    await store.appendPoint({
      turnIndex: 0, anchorSeq: 3, promptPreview: "t0",
      files: [
        record("a.txt", { preBlob: blob, afterHash: H("two") }),
        record("added.txt", { status: "added", isNewFile: true, afterHash: H("created-in-turn") }),
      ],
    })
    await store.appendPoint({ turnIndex: 1, anchorSeq: 20, promptPreview: "t1", files: [] })

    const events: RewindEvent[] = []
    let skipped: number | undefined
    const result = await service.execute(0, "all", {
      appendEvent: (ev) => events.push(ev),
      deriveSkip: (seq) => { skipped = seq },
    })
    expect(result.truncated).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.revertedFiles).toBe(2)
    expect(await (await import("node:fs/promises")).readFile(join(workspace, "a.txt"), "utf-8")).toBe("one")
    expect(existsSync(join(workspace, "added.txt"))).toBe(false)
    expect(events).toEqual([
      {
        type: "rewind/point", version: 1, targetTurn: 0, anchorSeq: 3, mode: "all",
        fileOps: [
          { path: "a.txt", op: "restore" },
          { path: "added.txt", op: "delete" },
        ],
      },
    ])
    expect(skipped).toBe(3)
    // journal truncated to before the target turn (0 points remain)
    expect(await store.readPoints()).toEqual([])
  })

  it("execute with mode conversation: no file ops, marker only, still truncates", async () => {
    const blob = await store.writeBlob(utf8("one"))
    await writeFile(join(workspace, "a.txt"), "two")
    await store.appendPoint({ turnIndex: 0, anchorSeq: 5, promptPreview: "t0", files: [record("a.txt", { preBlob: blob, afterHash: H("two") })] })
    const events: RewindEvent[] = []
    const result = await service.execute(0, "conversation", { appendEvent: (ev) => events.push(ev) })
    expect(result.revertedFiles).toBe(0) // no file ops
    expect(events[0]!.fileOps).toEqual([])
    expect(result.truncated).toBe(true)
    expect(await (await import("node:fs/promises")).readFile(join(workspace, "a.txt"), "utf-8")).toBe("two") // untouched
  })

  it("execute with mode files: restores files but NEVER truncates", async () => {
    const blob = await store.writeBlob(utf8("one"))
    await writeFile(join(workspace, "a.txt"), "two")
    await store.appendPoint({ turnIndex: 0, anchorSeq: 5, promptPreview: "t0", files: [record("a.txt", { preBlob: blob, afterHash: H("two") })] })
    const result = await service.execute(0, "files", { appendEvent: () => {} })
    expect(result.truncated).toBe(false)
    expect((await store.readPoints())).toHaveLength(1)
  })

  it("execute had_errors (missing blob) keeps points (no truncate) and reports errors", async () => {
    await writeFile(join(workspace, "a.txt"), "two")
    await store.appendPoint({ turnIndex: 0, anchorSeq: 5, promptPreview: "t0", files: [record("a.txt", { preBlob: "d".repeat(64), afterHash: H("two") })] })
    const result = await service.execute(0, "all", { appendEvent: () => {} })
    expect(result.errors).toHaveLength(1)
    expect(result.truncated).toBe(false)
    expect((await store.readPoints())).toHaveLength(1) // retry data preserved
  })

  it("target out of range fails loud", async () => {
    await expect(service.plan(0)).rejects.toThrow(RewindError)
    await expect(service.execute(0, "all", { appendEvent: () => {} })).rejects.toThrow(RewindError)
  })

  it("integration: recorder → service full loop", async () => {
    const recorder = new RewindRecorder({ store, workspace })
    await writeFile(join(workspace, "f.txt"), "before")
    recorder.begin(0, "round one")
    recorder.take("f.txt", utf8("before"))
    await writeFile(join(workspace, "f.txt"), "after")
    const point = (await recorder.finalize())!
    await store.appendPoint(point)

    const plan = await service.plan(0)
    expect(plan.clean).toHaveLength(1)
    const result = await service.execute(0, "all", { appendEvent: () => {} })
    expect(result.truncated).toBe(true)
    expect(await (await import("node:fs/promises")).readFile(join(workspace, "f.txt"), "utf-8")).toBe("before")
  })
})

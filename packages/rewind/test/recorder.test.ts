import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFile, mkdir } from "node:fs/promises"
import { RewindStore, RewindRecorder, sha256Hex } from "../src/index.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)

describe("RewindRecorder", () => {
  let root: string
  let workspace: string
  let store: RewindStore
  let recorder: RewindRecorder
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "i-harness-rewind-rec-"))
    workspace = join(root, "ws")
    await mkdir(workspace)
    store = new RewindStore({ root, sessionId: "r1" })
    recorder = new RewindRecorder({ store, workspace })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("take records pre-image + finalize writes point with afterHash", async () => {
    await writeFile(join(workspace, "a.txt"), "one")
    recorder.begin(0, "edit a.txt")
    const t = recorder.take("a.txt", utf8("one"))
    expect(t).toEqual({ blobId: sha256Hex(utf8("one")), isNewFile: false })
    await writeFile(join(workspace, "a.txt"), "two")
    const point = await recorder.finalize()
    expect(point).not.toBeNull()
    const p = point!
    expect(p.turnIndex).toBe(0)
    expect(p.anchorSeq).toBe(0)
    expect(p.promptPreview).toBe("edit a.txt")
    expect(p.files).toEqual([
      { path: "a.txt", status: "modified", preBlob: sha256Hex(utf8("one")), isNewFile: false, afterHash: sha256Hex(utf8("two")) },
    ])
    // the blob is persisted (content-addressed)
    expect(await store.hasBlob(sha256Hex(utf8("one")))).toBe(true)
  })

  it("null before = new file (isNewFile, no blob)", async () => {
    recorder.begin(1, "create")
    const t = recorder.take("new.txt", null)
    expect(t).toEqual({ blobId: null, isNewFile: true })
    await writeFile(join(workspace, "new.txt"), "content")
    const p = (await recorder.finalize())!
    expect(p.files).toEqual([
      { path: "new.txt", status: "added", isNewFile: true, afterHash: sha256Hex(utf8("content")) },
    ])
  })

  it("take-once per (turn, path): first pre-image wins", async () => {
    await writeFile(join(workspace, "a.txt"), "first")
    recorder.begin(0, "x")
    const first = recorder.take("a.txt", utf8("first"))
    const second = recorder.take("a.txt", utf8("second")) // a second write — captured pre is NOT the restore source
    expect(second).toEqual(first)
    await writeFile(join(workspace, "a.txt"), "third")
    const p = (await recorder.finalize())!
    expect(p.files).toEqual([
      { path: "a.txt", status: "modified", preBlob: sha256Hex(utf8("first")), isNewFile: false, afterHash: sha256Hex(utf8("third")) },
    ])
  })

  it("deleted file (existed then removed in the turn) is status deleted", async () => {
    await writeFile(join(workspace, "d.txt"), "payload")
    recorder.begin(0, "rm")
    recorder.take("d.txt", utf8("payload"))
    // simulating the delete
    const { unlink } = await import("node:fs/promises")
    await unlink(join(workspace, "d.txt"))
    const p = (await recorder.finalize())!
    expect(p.files[0]).toEqual({
      path: "d.txt",
      status: "deleted",
      preBlob: sha256Hex(utf8("payload")),
      isNewFile: false,
      // no afterHash — absent at turn end
    })
  })

  it("finalize with no pending turn returns null", async () => {
    expect(await recorder.finalize()).toBeNull()
  })

  it("begin is first-wins (a spliced second user/message does not re-anchor)", async () => {
    recorder.begin(0, "first prompt")
    recorder.begin(7, "second prompt")
    await writeFile(join(workspace, "a.txt"), "x")
    recorder.take("a.txt", utf8(""))
    const p = (await recorder.finalize())!
    expect(p.anchorSeq).toBe(0)
    expect(p.promptPreview).toBe("first prompt")
  })

  it("paths are normalized (backslash → slash / ./ dropped) and take outside a turn is dropped", async () => {
    recorder.begin(0, "x")
    recorder.take("sub\\b.txt", utf8(""))
    recorder.take("./c.txt", utf8(""))
    const p = (await recorder.finalize())!
    expect(p.files.map((f) => f.path).sort()).toEqual(["c.txt", "sub/b.txt"])
    // no pending turn → dropped, not tracked
    expect(recorder.take("nope.txt", null)).toEqual({ blobId: null, isNewFile: false })
  })

  it("finalize then next turn continues at turnIndex 1", async () => {
    await writeFile(join(workspace, "a.txt"), "x")
    recorder.begin(0, "t0")
    recorder.take("a.txt", utf8(""))
    // finalize RETURNS the point — the caller stores it; the next turn's
    // turnIndex derives from the journal length
    await store.appendPoint((await recorder.finalize())!)
    recorder.begin(10, "t1")
    recorder.take("a.txt", utf8("x"))
    const p = (await recorder.finalize())!
    expect(p.turnIndex).toBe(1)
    expect(p.anchorSeq).toBe(10)
  })
})

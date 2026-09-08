// M54 G3 (RED-first): the journal is bound to an absolute workspace via
// meta.json. Opening the same journal dir from another workspace must FAIL
// LOUD (typed REWIND_WORKSPACE_MISMATCH) — never silently restore into the
// wrong tree. A pre-M54 journal (no meta.json) keeps working: unknown
// workspace, adopted by the first workspace that writes.
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { RewindService, RewindStore, sha256Hex } from "../src/index.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)

describe("G3 journal workspace binding", () => {
  let root: string
  let wsA: string
  let wsB: string
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "i-harness-rewind-wsbind-"))
    wsA = join(root, "wsA")
    wsB = join(root, "wsB")
    await mkdir(wsA)
    await mkdir(wsB)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A journal with one point, bound to `workspace` (meta.json written). */
  async function seedJournal(workspace: string, sessionId = "g3"): Promise<void> {
    const store = new RewindStore({ root, sessionId, workspace })
    const blob = await store.writeBlob(utf8("A-pre-image"))
    await writeFile(join(workspace, "a.txt"), "A-after")
    await store.appendPoint({
      turnIndex: 0,
      anchorSeq: 0,
      promptPreview: "A turn",
      files: [{ path: "a.txt", status: "modified", preBlob: blob, isNewFile: false, afterHash: sha256Hex(utf8("A-after")) }],
    })
  }

  it("binds the journal to the absolute workspace via meta.json", async () => {
    await seedJournal(wsA)
    const meta = JSON.parse(readFileSync(join(root, "rewind", "g3", "meta.json"), "utf-8")) as { workspace?: string }
    expect(meta.workspace).toBe(resolve(wsA))
  })

  it("refuses points/plan/execute from a different workspace (typed error)", async () => {
    await seedJournal(wsA)
    const foreign = new RewindStore({ root, sessionId: "g3", workspace: wsB })
    const svc = new RewindService({ store: foreign, workspace: wsB })
    await expect(svc.points()).rejects.toMatchObject({ code: "REWIND_WORKSPACE_MISMATCH" })
    await expect(svc.plan(0)).rejects.toMatchObject({ code: "REWIND_WORKSPACE_MISMATCH" })
    await expect(svc.execute(0, "all", { appendEvent: () => {} })).rejects.toMatchObject({ code: "REWIND_WORKSPACE_MISMATCH" })
    // the wrong tree was never touched
    await expect(readFile(join(wsB, "a.txt"), "utf-8")).rejects.toThrow()
  })

  it("the same workspace keeps working", async () => {
    await seedJournal(wsA)
    const svc = new RewindService({ store: new RewindStore({ root, sessionId: "g3", workspace: wsA }), workspace: wsA })
    expect((await svc.points())[0]!.turnIndex).toBe(0)
    expect((await svc.plan(0)).ops).toHaveLength(1)
  })

  it("refuses to WRITE into a foreign journal (recorder/appendPoint)", async () => {
    await seedJournal(wsA)
    const foreign = new RewindStore({ root, sessionId: "g3", workspace: wsB })
    await expect(
      foreign.appendPoint({ turnIndex: 1, anchorSeq: 1, promptPreview: "x", files: [] }),
    ).rejects.toMatchObject({ code: "REWIND_WORKSPACE_MISMATCH" })
    expect(await new RewindStore({ root, sessionId: "g3", workspace: wsA }).readPoints()).toHaveLength(1)
  })

  // M54 final-review F2: recovery can unlink (the already-recorded branch) and
  // is reachable on the mismatch path — a foreign journal must be left
  // completely untouched, not "recovered" by the wrong workspace.
  it("recoverPending() leaves a foreign journal's stale pending sidecar untouched", async () => {
    const seed = new RewindStore({ root, sessionId: "g3", workspace: wsA })
    await seed.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "A", files: [] }) // binds wsA
    // crash between appendPoint and clearPending: the sidecar's turn IS recorded
    await seed.writePending({
      version: 1,
      anchorSeq: 0,
      promptPreview: "A",
      startedAt: 0,
      entries: [{ path: "a.txt", blobId: null, isNewFile: true }],
    })
    const foreign = new RewindStore({ root, sessionId: "g3", workspace: wsB })
    expect(await foreign.recoverPending()).toBeNull()
    expect(await foreign.readOrphans()).toEqual([]) // no archive from the wrong workspace
    // the owning workspace still sees (and can drop) its own stale sidecar
    expect(await seed.readPending()).toMatchObject({ anchorSeq: 0 })
    expect(await seed.recoverPending()).toBeNull() // already recorded → dropped, nothing lost
    expect(await seed.readPending()).toBeNull()
  })

  it("a legacy journal without meta.json keeps working (unknown workspace, adopted on write)", async () => {
    // pre-M54 store: no workspace option → no meta.json
    const legacy = new RewindStore({ root, sessionId: "legacy" })
    await writeFile(join(wsB, "a.txt"), "B-after")
    const blob = await legacy.writeBlob(utf8("B-pre"))
    await legacy.appendPoint({
      turnIndex: 0,
      anchorSeq: 0,
      promptPreview: "legacy",
      files: [{ path: "a.txt", status: "modified", preBlob: blob, isNewFile: false, afterHash: sha256Hex(utf8("B-after")) }],
    })
    expect(existsSync(join(root, "rewind", "legacy", "meta.json"))).toBe(false)
    // readable from any workspace — unknown binding is NOT a mismatch
    const svc = new RewindService({ store: new RewindStore({ root, sessionId: "legacy", workspace: wsB }), workspace: wsB })
    expect((await svc.plan(0)).ops).toHaveLength(1)
    // the first WRITE adopts the current workspace
    const bound = new RewindStore({ root, sessionId: "legacy", workspace: wsB })
    await bound.appendPoint({ turnIndex: 1, anchorSeq: 5, promptPreview: "adopt", files: [] })
    expect(JSON.parse(readFileSync(join(root, "rewind", "legacy", "meta.json"), "utf-8")).workspace).toBe(resolve(wsB))
    // ...after which a third workspace is refused
    const other = new RewindService({ store: new RewindStore({ root, sessionId: "legacy", workspace: wsA }), workspace: wsA })
    await expect(other.plan(0)).rejects.toMatchObject({ code: "REWIND_WORKSPACE_MISMATCH" })
  })

  it("a malformed meta.json is a loud store-corruption error", async () => {
    const dir = join(root, "rewind", "g3")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "meta.json"), "{not json")
    const svc = new RewindService({ store: new RewindStore({ root, sessionId: "g3", workspace: wsA }), workspace: wsA })
    await expect(svc.points()).rejects.toMatchObject({ code: "REWIND_STORE_CORRUPT" })
  })
})

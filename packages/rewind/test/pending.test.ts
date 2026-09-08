// M54 G2 (RED-first): a mid-turn crash must not silently lose the pending
// point and its pre-images. The durable pending sidecar survives the crash and
// reopens as an HONEST artifact — archived as an orphan, reported by plan()
// (unTracked + explicit orphanedTurns), never fabricated into a point and
// never auto-restored.
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { RewindRecorder, RewindService, RewindStore, sha256Hex } from "../src/index.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)

describe("G2 durable pending turn (mid-turn crash)", () => {
  let root: string
  let workspace: string
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "i-harness-rewind-pending-"))
    workspace = join(root, "ws")
    await mkdir(workspace)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const newStore = () => new RewindStore({ root, sessionId: "g2", workspace })

  /** One completed turn (point 0) followed by a crashed turn: pre-images taken,
   * the tool writes landed, but finalize() never ran (the process died). */
  async function seedCrashedTurn(): Promise<void> {
    const store = newStore()
    const rec = new RewindRecorder({ store, workspace })
    await writeFile(join(workspace, "a.txt"), "v1")
    rec.begin(0, "turn0")
    rec.take("a.txt", utf8("v0"))
    await writeFile(join(workspace, "a.txt"), "v1")
    const point = (await rec.finalize())!
    await store.appendPoint(point)
    await rec.commit(point.anchorSeq)

    rec.begin(10, "crash turn")
    rec.take("a.txt", utf8("v1"))
    rec.take("created.txt", null)
    await rec.flush()
    await writeFile(join(workspace, "a.txt"), "v2")
    await writeFile(join(workspace, "created.txt"), "brand-new")
  }

  it("take() persists pre-image blobs + the pending sidecar (crash window)", async () => {
    const store = newStore()
    const rec = new RewindRecorder({ store, workspace })
    rec.begin(10, "crash turn")
    rec.take("a.txt", utf8("v1"))
    rec.take("new.txt", null)
    await rec.flush()
    const pending = await store.readPending()
    expect(pending).toMatchObject({ version: 1, anchorSeq: 10, promptPreview: "crash turn" })
    expect(pending!.entries).toEqual([
      { path: "a.txt", blobId: sha256Hex(utf8("v1")), isNewFile: false },
      { path: "new.txt", blobId: null, isNewFile: true },
    ])
    // the pre-image blob is durable BEFORE the sidecar references it
    expect(await store.hasBlob(sha256Hex(utf8("v1")))).toBe(true)
  })

  it("take-once is preserved: a second write does not replace the first pre-image", async () => {
    const store = newStore()
    const rec = new RewindRecorder({ store, workspace })
    rec.begin(0, "x")
    const first = rec.take("a.txt", utf8("first"))
    const second = rec.take("a.txt", utf8("second"))
    expect(second).toEqual(first)
    await rec.flush()
    const pending = await store.readPending()
    expect(pending!.entries).toEqual([{ path: "a.txt", blobId: sha256Hex(utf8("first")), isNewFile: false }])
  })

  it("recoverPending() archives the crashed turn as an orphan (no fabricated point)", async () => {
    await seedCrashedTurn()
    const store = newStore() // reopen: the crashed process's objects are gone
    const recovered = await store.recoverPending()
    expect(recovered).toMatchObject({ anchorSeq: 10, promptPreview: "crash turn" })
    expect(recovered!.entries.map((e) => e.path)).toEqual(["a.txt", "created.txt"])
    expect(await store.readPending()).toBeNull()
    const orphans = await store.readOrphans()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({ anchorSeq: 10, promptPreview: "crash turn" })
    expect(typeof orphans[0]!.recoveredAt).toBe("number")
    // HONESTY: the journal keeps exactly the one recorded point — the crashed
    // turn is NOT fabricated into a point
    expect(await store.readPoints()).toHaveLength(1)
    // the pre-images survive (content-addressed); restoring them is a MANUAL act
    expect(await store.hasBlob(sha256Hex(utf8("v1")))).toBe(true)
    // idempotent: a second recovery finds nothing new
    expect(await store.recoverPending()).toBeNull()
    expect(await store.readOrphans()).toHaveLength(1)
  })

  it("plan() marks the recovered orphan (unTracked + orphanedTurns, no ops)", async () => {
    await seedCrashedTurn()
    const store = newStore()
    await store.recoverPending()
    const svc = new RewindService({ store, workspace })
    const plan = await svc.plan(0)
    expect(plan.unTracked).toEqual(["created.txt"]) // a.txt is already in the target set
    expect(plan.orphanedTurns).toEqual([
      { anchorSeq: 10, promptPreview: "crash turn", files: ["a.txt", "created.txt"], recoveredAt: expect.any(Number) },
    ])
    // no fabricated restore: only the recorded point's file is op'd
    expect(plan.ops.map((o) => o.path)).toEqual(["a.txt"])
  })

  it("plan() marks an un-archived sidecar too (recovery never ran)", async () => {
    await seedCrashedTurn()
    const svc = new RewindService({ store: newStore(), workspace })
    const plan = await svc.plan(0)
    expect(plan.unTracked).toEqual(["created.txt"])
    expect(plan.orphanedTurns?.[0]).toMatchObject({ anchorSeq: 10, files: ["a.txt", "created.txt"] })
    expect(plan.orphanedTurns?.[0]?.recoveredAt).toBeUndefined()
  })

  it("a normal turn after recovery finalizes exactly once and clears its sidecar", async () => {
    await seedCrashedTurn()
    const store = newStore()
    await store.recoverPending()
    const rec = new RewindRecorder({ store, workspace })
    rec.begin(20, "turn2")
    rec.take("b.txt", null)
    await writeFile(join(workspace, "b.txt"), "new file")
    const point = (await rec.finalize())!
    await store.appendPoint(point)
    await rec.commit(point.anchorSeq)
    const points = await store.readPoints()
    expect(points.map((p) => p.turnIndex)).toEqual([0, 1])
    expect(points.filter((p) => p.anchorSeq === 20)).toHaveLength(1)
    expect(await store.readPending()).toBeNull()
    expect(await store.readOrphans()).toHaveLength(1)
  })

  it("recoverPending() drops a sidecar whose point is already in the journal", async () => {
    const store = newStore()
    const rec = new RewindRecorder({ store, workspace })
    rec.begin(0, "t0")
    rec.take("a.txt", null)
    await writeFile(join(workspace, "a.txt"), "x")
    const point = (await rec.finalize())!
    await store.appendPoint(point) // committed... then the process died before commit()
    const reopened = newStore()
    expect(await reopened.recoverPending()).toBeNull() // nothing was lost
    expect(await reopened.readOrphans()).toEqual([])
    expect(await reopened.readPending()).toBeNull()
  })

  it("clearPending(anchorSeq) leaves a newer turn's sidecar in place", async () => {
    const store = newStore()
    const rec = new RewindRecorder({ store, workspace })
    rec.begin(1, "old")
    rec.take("a.txt", null)
    await rec.flush()
    await rec.finalize()
    rec.begin(2, "new")
    rec.take("b.txt", null)
    await rec.flush()
    await store.clearPending(1) // the OLD turn's commit must not clear the new sidecar
    expect((await store.readPending())!.anchorSeq).toBe(2)
  })
})

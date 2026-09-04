import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RewindStore, RewindError, normalizeRelPath } from "../src/index.ts"
import type { RewindPoint } from "../src/index.ts"

const utf8 = (s: string) => new TextEncoder().encode(s)

function point(turnIndex: number): RewindPoint {
  return { turnIndex, anchorSeq: 0, promptPreview: `turn ${turnIndex}`, files: [] }
}

describe("RewindStore", () => {
  let root: string
  let store: RewindStore
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i-harness-rewind-store-"))
    store = new RewindStore({ root, sessionId: "s1" })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("writes points.jsonl at <root>/rewind/<sessionId>/points.jsonl", async () => {
    await store.appendPoint(point(0))
    expect(existsSync(join(root, "rewind", "s1", "points.jsonl"))).toBe(true)
    expect(await store.readPoints()).toHaveLength(1)
  })

  it("appends are atomic (temp+rename — no stray temp files left)", async () => {
    await store.appendPoint(point(0))
    await store.appendPoint(point(1))
    const dir = readdirSync(store.storeDir)
    expect(dir).toEqual(["points.jsonl"])
    expect((await store.readPoints()).map((p) => p.turnIndex)).toEqual([0, 1])
  })

  it("rows round-trip exactly (preBlob/afterHash/isNewFile included)", async () => {
    const p: RewindPoint = {
      turnIndex: 2,
      anchorSeq: 7,
      promptPreview: "do it",
      files: [
        { path: "a/b.txt", status: "modified", preBlob: "a".repeat(64), isNewFile: false, afterHash: "b".repeat(64) },
        { path: "c.txt", status: "added", isNewFile: true },
      ],
    }
    await store.appendPoint(p)
    const [got] = await store.readPoints()
    expect(got).toEqual(p)
  })

  it("missing journal reads as []", async () => {
    expect(await store.readPoints()).toEqual([])
  })

  it("truncate keeps the first N points atomically", async () => {
    await store.appendPoint(point(0))
    await store.appendPoint(point(1))
    await store.appendPoint(point(2))
    await store.truncate(2)
    expect((await store.readPoints()).map((p) => p.turnIndex)).toEqual([0, 1])
  })

  it("truncate(0) empties the journal", async () => {
    await store.appendPoint(point(0))
    await store.truncate(0)
    expect(await store.readPoints()).toEqual([])
  })

  it("negative truncate fails loud", async () => {
    await expect(store.truncate(-1)).rejects.toThrow(RewindError)
  })

  it("blobs: content-addressed write/read/has + dedup writes once", async () => {
    const id1 = await store.writeBlob(utf8("hello"))
    const id2 = await store.writeBlob(utf8("hello"))
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^[a-f0-9]{64}$/)
    expect(await store.hasBlob(id1)).toBe(true)
    expect(await store.readBlob(id1)).toEqual(utf8("hello"))
    // idempotent — the blob dir holds exactly one file for the same content
    expect(readdirSync(store.blobsDir)).toHaveLength(1)
  })

  it("readBlob missing fails with REWIND_BLOB_MISSING", async () => {
    await expect(store.readBlob("c".repeat(64))).rejects.toThrow(/not found|REWIND_PATH_REFUSED|REWIND_BLOB_MISSING/)
  })

  it("blob ids that are not sha256 hex are refused", async () => {
    expect(() => store.blobPath("../../etc/passwd")).toThrow(RewindError)
    expect(() => store.blobPath("nothex")).toThrow(RewindError)
    await expect(store.hasBlob("nothex")).rejects.toThrow(RewindError)
  })

  it("sessionId path-traversal is refused", () => {
    expect(() => new RewindStore({ root, sessionId: "../evil" })).toThrow(RewindError)
    expect(() => new RewindStore({ root, sessionId: "a/b" })).toThrow(RewindError)
    expect(() => new RewindStore({ root, sessionId: "" })).toThrow(RewindError)
  })

  it("points.jsonl malformed line fails loud (REWIND_STORE_CORRUPT)", async () => {
    mkdirSync(store.storeDir, { recursive: true })
    writeFileSync(store.pointsFile, "{not json}\n")
    await expect(store.readPoints()).rejects.toThrow(RewindError)
  })

  it("normalizeRelPath: ../ and absolute refused, ./ and backslash normalized", () => {
    expect(normalizeRelPath("a.txt")).toBe("a.txt")
    expect(normalizeRelPath("./a.txt")).toBe("a.txt")
    expect(normalizeRelPath("a\\b\\c.txt")).toBe("a/b/c.txt")
    expect(() => normalizeRelPath("../x.txt")).toThrow(RewindError)
    expect(() => normalizeRelPath("a/../../x.txt")).toThrow(RewindError)
    expect(() => normalizeRelPath("/etc/passwd")).toThrow(RewindError)
    expect(() => normalizeRelPath("C:/tmp/x")).toThrow(RewindError)
    expect(() => normalizeRelPath("")).toThrow(RewindError)
    expect(() => normalizeRelPath(".")).toThrow(RewindError)
  })
})

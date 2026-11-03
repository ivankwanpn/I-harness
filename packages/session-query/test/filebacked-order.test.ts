import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { closeSessionQueries } from "../src/index.ts"
import { createFileBackedSessionQuery, type InspectOutcome } from "../src/file-backed.ts"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ih-q-order-"))
  const file = join(dir, "session.jsonl")
  const dbPath = join(dir, "index.db")
  const content = (text: string) => [
    JSON.stringify({ formatVersion: 1, sessionId: "session", createdAt: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ type: "assistant/message", seq: 7, text }),
    "",
  ].join("\n")
  writeFileSync(file, content("original zebra"))
  return { dir, file, dbPath, content, cleanup() { closeSessionQueries(); rmSync(dir, { recursive: true, force: true }) } }
}

describe("file-backed ownership and observation order", () => {
  it("captures option getters once in the original order before opening the database", async () => {
    const f = fixture()
    try {
      const trace: string[] = []
      const q = createFileBackedSessionQuery({
        get storeRoot() { trace.push("storeRoot"); return f.dir },
        get dbPath() { trace.push("dbPath"); return f.dbPath },
        get signal() { trace.push("signal"); return undefined },
        get onInspect() {
          trace.push("onInspect")
          expect(() => readFileSync(f.dbPath)).toThrow()
          return (_id: string, outcome: InspectOutcome) => { trace.push(outcome) }
        },
      })
      expect(trace).toEqual(["storeRoot", "dbPath", "signal", "onInspect"])
      await q.search("zebra")
      await q.lineage("session", { direction: "children" })
      expect(trace).toEqual(["storeRoot", "dbPath", "signal", "onInspect", "indexed", "skip"])
    } finally { f.cleanup() }
  })

  it("commits before inspection and lets the next queued observer recover from a callback failure", async () => {
    const f = fixture()
    try {
      const outcomes: string[] = []
      const q = createFileBackedSessionQuery({ storeRoot: f.dir, dbPath: f.dbPath, onInspect: (_id, outcome) => {
        outcomes.push(outcome)
        if (outcome === "indexed") {
          const check = new DatabaseSync(f.dbPath, { readOnly: true })
          try { expect(check.prepare("SELECT COUNT(*) AS count FROM indexed_docs").get()).toEqual({ count: 1 }) }
          finally { check.close() }
          throw new Error("inspection hook failed")
        }
      } })
      const [first, next] = await Promise.allSettled([q.search("zebra"), q.search("zebra")])
      expect(first).toMatchObject({ status: "rejected", reason: { message: "inspection hook failed" } })
      expect(next).toMatchObject({ status: "fulfilled", value: [expect.objectContaining({ seq: 7 })] })
      expect(outcomes).toEqual(["indexed", "skip"])
    } finally { f.cleanup() }
  })

  it("rolls back a failed rebuild and recovers after the source becomes valid", async () => {
    const f = fixture()
    try {
      const q = createFileBackedSessionQuery({ storeRoot: f.dir, dbPath: f.dbPath })
      const before = await q.search("zebra")
      const broken = f.content("changed").replace('"text":"changed"', '"text":{"bad":"sqlite binding"}')
      writeFileSync(f.file, broken)
      await expect(q.search("zebra")).rejects.toThrow()
      const check = new DatabaseSync(f.dbPath, { readOnly: true })
      try {
        expect(check.prepare("SELECT text FROM indexed_docs").all()).toEqual([{ text: "original zebra" }])
        expect(check.prepare("SELECT time FROM indexed_docs").get()).toEqual({ time: before[0]!.time })
      } finally { check.close() }
      writeFileSync(f.file, f.content("recovered zebra source"))
      expect(await q.search("recovered")).toHaveLength(1)
    } finally { f.cleanup() }
  })

  it("re-stats after the committed inspection callback and fails after exactly two moving observations", async () => {
    const f = fixture()
    try {
      const outcomes: string[] = []
      const q = createFileBackedSessionQuery({ storeRoot: f.dir, onInspect: (_id, outcome) => {
        outcomes.push(outcome)
        writeFileSync(f.file, f.content(`zebra ${"moving ".repeat(outcomes.length)}`))
      } })
      await expect(q.search("zebra")).rejects.toMatchObject({
        code: "SESSION_QUERY_OBSERVE_FAILED",
        message: expect.stringContaining("file kept changing across retries"),
      })
      expect(outcomes).toEqual(["indexed", "indexed"])
    } finally { f.cleanup() }
  })

  it("checks cancellation between sessions and before later empty searches", async () => {
    const f = fixture()
    try {
      writeFileSync(join(f.dir, "second.jsonl"), f.content("second zebra"))
      const controller = new AbortController()
      const outcomes: string[] = []
      const q = createFileBackedSessionQuery({ storeRoot: f.dir, signal: controller.signal, onInspect: (_id, outcome) => {
        outcomes.push(outcome)
        controller.abort()
      } })
      await expect(q.search("zebra")).rejects.toThrow("session query aborted")
      expect(outcomes).toEqual(["indexed"])
      await expect(q.search(" ")).rejects.toThrow("session query aborted")
    } finally { f.cleanup() }
  })

  it("indexes only the contiguous valid prefix without repairing a torn tail", async () => {
    const f = fixture()
    try {
      const bytes = f.content("prefix zebra") + 'TORN{\n' + JSON.stringify({ type: "assistant/message", text: "excluded tail" })
      writeFileSync(f.file, bytes)
      const q = createFileBackedSessionQuery({ storeRoot: f.dir })
      expect(await q.search("prefix")).toHaveLength(1)
      expect(await q.search("excluded")).toEqual([])
      expect(readFileSync(f.file, "utf8")).toBe(bytes)
    } finally { f.cleanup() }
  })

  it("public close releases both query instances and remains idempotent", async () => {
    const f = fixture()
    try {
      const first = createFileBackedSessionQuery({ storeRoot: f.dir, dbPath: f.dbPath })
      const second = createFileBackedSessionQuery({ storeRoot: f.dir })
      await first.search("zebra")
      await second.search("zebra")
      closeSessionQueries()
      closeSessionQueries()
      await expect(first.search("zebra")).rejects.toThrow(/not open/)
      await expect(second.search("zebra")).rejects.toThrow(/not open/)
    } finally { f.cleanup() }
  })
})

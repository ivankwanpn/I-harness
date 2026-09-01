import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { closeSessionQueries } from "../src/index.ts"
import { createFileBackedSessionQuery, SessionQueryError } from "../src/file-backed.ts"

/** Seed a jsonl store with one session (header + events) via the coordinator;
 * the FILE is the authority — the query index must consume it read-only. */
async function seededStore(text: string = "hello 獨角獸"): Promise<{ dir: string; id: string }> {
  const dir = mkdtempSync(join(tmpdir(), "ih-q-"))
  const coord = createSessionCoordinator(createJsonlBackend(dir))
  const { id } = await coord.create()
  const s = createSession()
  append(s, { type: "user/message", text })
  append(s, { type: "assistant/message", text: "world" })
  await coord.append(id, s.events)
  await coord.close()
  return { dir, id }
}

function cleanup(dir: string): void {
  closeSessionQueries()
  rmSync(dir, { recursive: true, force: true })
}

describe("file-backed session query (reconcile-on-search)", () => {
  it("indexes on first search (reconcile-on-search)", async () => {
    const { dir, id } = await seededStore()
    try {
      const q = createFileBackedSessionQuery({ storeRoot: dir })
      const hits = await q.search("獨角獸")
      expect(hits).toContainEqual(expect.objectContaining({ sessionId: id, eventType: "user/message" }))
      // "world" is assistant/message text and must be reachable too.
      const worldHits = await q.search("world")
      expect(worldHits.length).toBe(1)
      expect(worldHits[0]!.sessionId).toBe(id)
    } finally {
      cleanup(dir)
    }
  })

  it("lineage is served from the jsonl header (create meta)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-q-lineage-"))
    try {
      const coord = createSessionCoordinator(createJsonlBackend(dir))
      await coord.create({ sessionId: "parent" })
      await coord.create({ sessionId: "child", parentSession: "parent", delegationDepth: 1, origin: "subagent" })
      await coord.close()
      const q = createFileBackedSessionQuery({ storeRoot: dir })
      const nodes = await q.lineage("parent", { direction: "children" })
      expect(nodes.map((n) => n.sessionId)).toEqual(["child"])
      expect(nodes[0]!.parentSession).toBe("parent")
      expect(nodes[0]!.delegationDepth).toBe(1)
      expect(nodes[0]!.origin).toBe("subagent")
      // unknown session fails closed (existing SessionQuery contract)
      await expect(q.lineage("nope", { direction: "children" })).rejects.toThrow(/unknown session/)
    } finally {
      cleanup(dir)
    }
  })

  it("skips unchanged sessions on the second search (single inspection)", async () => {
    const { dir, id } = await seededStore()
    try {
      const outcomes: { id: string; outcome: string }[] = []
      const q = createFileBackedSessionQuery({
        storeRoot: dir,
        onInspect: (sid, outcome) => outcomes.push({ id: sid, outcome }),
      })
      await q.search("獨角獸")
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(["indexed"])
      outcomes.length = 0
      await q.search("world")
      // unchanged revision → no second look at the file (skip), no stale rows
      expect(outcomes).toEqual([{ id, outcome: "skip" }])
      // and a third search indexes nothing either
      outcomes.length = 0
      await q.search("miss")
      expect(outcomes).toEqual([{ id, outcome: "skip" }])
    } finally {
      cleanup(dir)
    }
  })

  it("reindexes a session whose file changed (append after first index)", async () => {
    const { dir, id } = await seededStore()
    try {
      const q = createFileBackedSessionQuery({ storeRoot: dir })
      expect((await q.search("zebra")).length).toBe(0)
      const coord = createSessionCoordinator(createJsonlBackend(dir))
      await coord.append(id, [{ type: "user/message", text: "a zebra crossed the purple unicorn" }])
      await coord.close()
      const hits = await q.search("zebra")
      expect(hits).toHaveLength(1)
      expect(hits[0]!.sessionId).toBe(id)
    } finally {
      cleanup(dir)
    }
  })

  it("removes a deleted session's rows on the next reconcile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-q-del-"))
    try {
      const coord = createSessionCoordinator(createJsonlBackend(dir))
      await coord.create({ sessionId: "keep" })
      await coord.create({ sessionId: "drop" })
      await coord.append("keep", [{ type: "user/message", text: "unicorn keep" }])
      await coord.append("drop", [{ type: "user/message", text: "unicorn drop" }])
      await coord.close()
      const outcomes: string[] = []
      const q = createFileBackedSessionQuery({ storeRoot: dir, onInspect: (_sid, o) => outcomes.push(o) })
      const before = await q.search("unicorn")
      expect(new Set(before.map((h) => h.sessionId))).toEqual(new Set(["keep", "drop"]))
      rmSync(join(dir, "drop.jsonl"))
      outcomes.length = 0
      const after = await q.search("unicorn")
      expect(after.map((h) => h.sessionId)).toEqual(["keep"])
      expect(outcomes).toEqual(["removed", "skip"])
    } finally {
      cleanup(dir)
    }
  })

  it("does not rebuild when a changed stat carries identical content (fingerprint)", async () => {
    const { dir } = await seededStore("stable content")
    try {
      const file = join(dir, `${(await readdirFileId(dir))}.jsonl`)
      const outcomes: string[] = []
      const q = createFileBackedSessionQuery({ storeRoot: dir, onInspect: (_sid, o) => outcomes.push(o) })
      await q.search("stable")
      expect((await q.search("stable")).length).toBeGreaterThan(0)
      // rewrite the SAME bytes (mtime/ctime change, content identical)
      outcomes.length = 0
      await new Promise((r) => setTimeout(r, 30))
      writeFileSync(file, await readFile(file))
      await q.search("stable")
      // fingerprint equality → no re-index, only the revision row is touched
      expect(outcomes).toContain("content-equal")
      expect(outcomes).not.toContain("indexed")
    } finally {
      cleanup(dir)
    }
  })

  it("fails loud on an unreadable source and never serves stale rows", async () => {
    const { dir, id } = await seededStore()
    try {
      const q = createFileBackedSessionQuery({ storeRoot: dir })
      expect((await q.search("獨角獸")).length).toBe(1)
      // corrupt the header of the (once-indexed) file — the index must NOT
      // silently serve the previously built rows.
      writeFileSync(join(dir, `${id}.jsonl`), "NOT-A-JSON-HEADER\n")
      await expect(q.search("獨角獸")).rejects.toMatchObject({ code: "SESSION_QUERY_OBSERVE_FAILED" })
    } finally {
      cleanup(dir)
    }
  })

  it("rejects a foreign database file (application_id mismatch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-q-foreign-"))
    try {
      // An old-style persistence db: application_id 0x4948524E ("IHRN") —
      // the new index must refuse to touch it (SESSION_QUERY_INDEX_FOREIGN).
      const foreignPath = join(dir, "sessions.db")
      const foreign = new DatabaseSync(foreignPath)
      foreign.exec("CREATE TABLE foo (x)")
      foreign.exec("PRAGMA application_id = 0x4948524E")
      foreign.close()
      let caught: unknown
      try {
        createFileBackedSessionQuery({ storeRoot: join(dir, "a-separate-store"), dbPath: foreignPath })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SessionQueryError)
      expect((caught as SessionQueryError).code).toBe("SESSION_QUERY_INDEX_FOREIGN")
      // and the foreign file is byte-untouched (no schema written)
      expect((await readFile(foreignPath, "utf-8")).slice(0, 24)).not.toContain("indexed_sessions")
    } finally {
      cleanup(dir)
    }
  })

  it("creates a missing index dbPath with the owned schema and 0o600 semantics", async () => {
    const { dir } = await seededStore()
    try {
      const dbPath = join(dir, "query-index.db")
      const q = createFileBackedSessionQuery({ storeRoot: dir, dbPath })
      expect((await q.search("獨角獸")).length).toBe(1)
      expect(existsSync(dbPath)).toBe(true)
      // reopen read-only and verify our identity + table presence
      const check = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const { application_id: app } = check.prepare("PRAGMA application_id").get() as { application_id: number }
        const verRow = check.prepare("PRAGMA user_version").get() as { user_version: number }
        expect(app).toBe(0x49485155)
        expect(verRow.user_version).toBe(1)
        const tables = (check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' OR type = 'virtual'").all() as { name: string }[]).map((t) => t.name)
        for (const t of ["indexed_sessions", "indexed_docs", "lineage"]) expect(tables).toContain(t)
      } finally {
        check.close()
      }
    } finally {
      cleanup(dir)
    }
  })
})

async function readdirFileId(dir: string): Promise<string> {
  const { readdir } = await import("node:fs/promises")
  const names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl") && !n.endsWith(".doc.jsonl"))
  if (names.length !== 1) throw new Error(`expected exactly 1 session file, got ${names.join(", ")}`)
  return names[0]!.slice(0, -".jsonl".length)
}

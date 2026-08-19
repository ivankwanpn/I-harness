import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { closeSqliteBackends, createSqliteBackend } from "@i-harness/session-persistence-sqlite"
import { closeSessionQueries, createSessionQuery } from "../src/index.ts"

function cleanup(dir: string): void {
  closeSessionQueries()
  closeSqliteBackends()
  rmSync(dir, { recursive: true, force: true })
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "m10b-q-"))
  const dbPath = join(dir, "sessions.db")
  const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
  const query = createSessionQuery(dbPath)
  return { dir, dbPath, coordinator, query }
}

async function seed(coordinator: ReturnType<typeof createSessionCoordinator>) {
  const parent = (await coordinator.create({ sessionId: "parent" })).id
  const child = (await coordinator.create({ sessionId: "child", parentSession: "parent", delegationDepth: 1, origin: "subagent" })).id
  const grand = (await coordinator.create({ sessionId: "grand", parentSession: "child", delegationDepth: 2, origin: "subagent" })).id
  await coordinator.append("parent", [{ type: "user/message", text: "the purple unicorn fixed the parser" }])
  await coordinator.append("parent", [{ type: "tool/result", callId: "c", name: "bash", output: { stdout: "unicorn done" } }])
  await coordinator.append("child", [{ type: "user/message", text: "the green dragon slept" }])
  await coordinator.append("grand", [{ type: "user/message", text: "purple unicorn lineage" }])
  return { parent, child, grand }
}

describe("session-query", () => {
  it("searches events with BM25 ordering, snippets, and limit clamp", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      await seed(coordinator)
      const hits = await query.search("unicorn")
      expect(hits.length).toBeGreaterThanOrEqual(2)
      expect(hits[0]!.snippet.toLowerCase()).toContain("unicorn")
      expect(hits.every((h) => h.sessionId === "parent" || h.sessionId === "grand")).toBe(true)
      const limited = await query.search("unicorn", { limit: 1 })
      expect(limited.length).toBe(1)
    } finally {
      cleanup(dir)
    }
  })

  it("treats FTS syntax as literal text (no injection)", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      await seed(coordinator)
      await coordinator.append("parent", [{ type: "user/message", text: "a star OR neat * boom" }])
      const hits = await query.search("a star OR neat * boom")
      expect(hits.length).toBe(1) // the literal-phrase event only
      expect(await query.search("   ")).toEqual([]) // whitespace-only → []
    } finally {
      cleanup(dir)
    }
  })

  it("filters by sessionId and subtreeOf", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      await seed(coordinator)
      const single = await query.search("unicorn", { sessionId: "parent" })
      expect(single.length).toBe(2)
      expect(single.every((h) => h.sessionId === "parent")).toBe(true)
      const subtree = await query.search("unicorn", { subtreeOf: "child" }) // child + grand, but only grand matches "unicorn"
      expect(subtree.map((h) => h.sessionId)).toEqual(["grand"])
    } finally {
      cleanup(dir)
    }
  })

  it("lineage: ancestors nearest-first with depth cap", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      await seed(coordinator)
      const ancestors = await query.lineage("grand", { direction: "ancestors" })
      expect(ancestors.map((n) => n.sessionId)).toEqual(["child", "parent"])
      const capped = await query.lineage("grand", { direction: "ancestors", depth: 1 })
      expect(capped.map((n) => n.sessionId)).toEqual(["child"])
    } finally {
      cleanup(dir)
    }
  })

  it("lineage: descendants BFS with depth, children, hasChildren", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      await seed(coordinator)
      const desc = await query.lineage("parent", { direction: "descendants" })
      expect(desc.map((n) => n.sessionId)).toEqual(["child", "grand"])
      const depth1 = await query.lineage("parent", { direction: "descendants", depth: 1 })
      expect(depth1.map((n) => n.sessionId)).toEqual(["child"])
      const children = await query.lineage("parent", { direction: "children" })
      expect(children.map((n) => n.sessionId)).toEqual(["child"])
      expect(children[0]!.hasChildren).toBe(true) // child has a grandchild
      expect(children[0]!.parentSession).toBe("parent")
    } finally {
      cleanup(dir)
    }
  })

  it("lineage: unknown session and invalid depth throw; capability fails closed", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      await seed(coordinator)
      await expect(query.lineage("nope", { direction: "children" })).rejects.toThrow(/unknown session/)
      await expect(query.lineage("parent", { direction: "children", depth: 0 })).rejects.toThrow(/invalid depth/)
      await expect(query.lineage("parent", { direction: "ancestors", depth: -1 })).rejects.toThrow(/invalid depth/)
      // capability gate: a non-session DB lacks events_fts
      const bareDir = mkdtempSync(join(tmpdir(), "m10b-bare-"))
      const barePath = join(bareDir, "x.db")
      const { DatabaseSync } = await import("node:sqlite")
      new DatabaseSync(barePath).close()
      const bareQuery = createSessionQuery(barePath)
      try {
        await expect(bareQuery.search("x")).rejects.toThrow(/events_fts/)
      } finally {
        closeSessionQueries()
        rmSync(bareDir, { recursive: true, force: true })
      }
    } finally {
      cleanup(dir)
    }
  })
})

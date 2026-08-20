import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createToolRegistry } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { closeSqliteBackends, createSqliteBackend } from "@i-harness/session-persistence-sqlite"
import { createSessionQuery, createSessionQueryTools, closeSessionQueries } from "../src/index.ts"

describe("session-query tools", () => {
  it("registers session_search and lineage as read-only direct tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m10b-tools-"))
    try {
      const dbPath = join(dir, "sessions.db")
      const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
      await coordinator.create({ sessionId: "parent" })
      await coordinator.create({ sessionId: "child", parentSession: "parent" })
      await coordinator.append("parent", [{ type: "user/message", text: "searchable needle phrase" }])

      const ctx = createContext()
      const registry = createToolRegistry(ctx)
      for (const tool of createSessionQueryTools(createSessionQuery(dbPath))) registry.register(tool)
      const names = registry.schemas().map((s) => s.name).sort()
      expect(names).toEqual(["lineage", "session_search"])

      const searchTool = registry.get("session_search")!
      expect(searchTool.isReadOnly).toBe(true)
      const found = await registry.execute({ name: "session_search", args: { query: "needle" } })
      const hits = (found.output as { hits: { sessionId: string; snippet: string }[] }).hits
      expect(hits.length).toBe(1)
      expect(hits[0]!.sessionId).toBe("parent")

      const lineageTool = registry.get("lineage")!
      expect(lineageTool.isReadOnly).toBe(true)
      const res = await registry.execute({ name: "lineage", args: { session_id: "parent", direction: "children" } })
      const nodes = (res.output as { nodes: { sessionId: string; hasChildren: boolean }[] }).nodes
      expect(nodes.map((n) => n.sessionId)).toEqual(["child"])
      await expect(registry.execute({ name: "lineage", args: { session_id: "parent", direction: "sideways" } }))
        .rejects.toThrow(/invalid direction/)
    } finally {
      closeSessionQueries()
      closeSqliteBackends()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("marks session_search and lineage isConcurrencySafe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m10b-tools-cc-"))
    try {
      const dbPath = join(dir, "sessions.db")
      const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
      await coordinator.create({ sessionId: "parent" })
      const tools = createSessionQueryTools(createSessionQuery(dbPath))
      const search = tools.find((t) => t.name === "session_search")!
      const lineage = tools.find((t) => t.name === "lineage")!
      expect(search.isConcurrencySafe).toBe(true)
      expect(lineage.isConcurrencySafe).toBe(true)
    } finally {
      closeSessionQueries()
      closeSqliteBackends()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("propagates errors as tool failures (unknown session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m10b-tools2-"))
    try {
      const dbPath = join(dir, "sessions.db")
      const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
      await coordinator.create({ sessionId: "parent" })
      const ctx = createContext()
      const registry = createToolRegistry(ctx)
      for (const tool of createSessionQueryTools(createSessionQuery(dbPath))) registry.register(tool)
      await expect(registry.execute({ name: "lineage", args: { session_id: "nope", direction: "children" } }))
        .rejects.toThrow(/unknown session/)
    } finally {
      closeSessionQueries()
      closeSqliteBackends()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import { it, expect } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMemoryStore, createMemoryTools, MEMORY_NOTICE } from "../src/index.ts"
import { createToolRegistry } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
import { createApprovalPolicy } from "@i-harness/guard-approval"

it("does not save denied notes and searches an approved note with provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-memory-tools-"))
  const store = openMemoryStore({ path: join(root, "memory.sqlite"), scope: "workspace" })
  try {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    const tools = createMemoryTools(store)
    for (const tool of tools) registry.register(tool)
    createApprovalPolicy(ctx, registry, { workspace: root })
    let approved = false
    let asks = 0
    ctx.services.register("approval/answerer", async () => { asks++; return approved })
    const call = { name: "memory_note", args: { title: "decision", text: "pnpm" } }
    await expect(registry.prepare(call, undefined, { sessionId: "s" })).rejects.toThrow()
    expect(store.list()).toEqual([])
    expect(asks).toBe(1)
    approved = true
    await registry.dispatch(await registry.prepare(call, undefined, { sessionId: "s" }))
    expect(asks).toBe(2)
    expect(await tools.find(t => t.name === "memory_search")!.execute({ query: "pnpm" }, {})).toMatchObject({
      notice: MEMORY_NOTICE, hits: [expect.objectContaining({ sessionId: "s" })],
    })
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

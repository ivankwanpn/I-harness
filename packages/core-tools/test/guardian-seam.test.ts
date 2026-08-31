import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool, type GuardianVerdict } from "../src/index.ts"

function setup(answerer: (() => Promise<boolean>) | undefined, guardian: (() => Promise<GuardianVerdict>) | undefined) {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  const tool: Tool = {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    isReadOnly: false,
    execute: async () => ({ ok: true }),
  }
  registry.register(tool)
  // mimic guard-approval's ask classification with a bare waterfall seed — the
  // guardian seam only cares that the resolved decision is an ask.
  let answererCalled = 0
  let guardianCalled = 0
  ctx.waterfall("tools/pre-execute", async (payload, next) => {
    const chain = await next(payload)
    const call = payload as { name?: string }
    if (call.name === "write") return { kind: "ask", reason: "non-readonly tool" }
    return chain
  })
  if (answerer) {
    ctx.services.register("approval/answerer", async () => {
      answererCalled += 1
      return answerer()
    })
  }
  if (guardian) {
    ctx.services.register("approval/guardian", async () => {
      guardianCalled += 1
      return guardian()
    })
  }
  return { ctx, registry, counts: () => ({ answererCalled, guardianCalled }) }
}

describe("approval guardian seam", () => {
  it("deny short-circuits without touching the answerer", async () => {
    const { registry, counts } = setup(
      async () => { throw new Error("answerer must not run") },
      async () => ({ outcome: "deny", rationale: "rm -rf is extreme" }),
    )
    await expect(registry.execute({ name: "write", args: { path: "." } })).rejects.toThrow(/guardian denied: rm -rf is extreme/)
    const c = counts()
    expect(c.guardianCalled).toBe(1)
    expect(c.answererCalled).toBe(0)
  })

  it("approve auto-approves; the answerer is skipped", async () => {
    const { registry, counts } = setup(
      async () => { throw new Error("answerer must not run") },
      async () => ({ outcome: "approve", rationale: "trusted rule" }),
    )
    const result = await registry.execute({ name: "write", args: { path: "x" } })
    expect(result.output).toEqual({ ok: true })
    expect(counts().answererCalled).toBe(0)
  })

  it("allow defers to the human answerer", async () => {
    const { registry, counts } = setup(
      async () => true,
      async () => ({ outcome: "allow", rationale: "ask the user" }),
    )
    await registry.execute({ name: "write", args: { path: "x" } })
    expect(counts().answererCalled).toBe(1)
  })

  it("absent guardian keeps the pre-R-A9 behavior (answerer alone)", async () => {
    const { registry, counts } = setup(async () => true, undefined)
    await registry.execute({ name: "write", args: { path: "x" } })
    expect(counts().guardianCalled).toBe(0)
    expect(counts().answererCalled).toBe(1)
  })
})

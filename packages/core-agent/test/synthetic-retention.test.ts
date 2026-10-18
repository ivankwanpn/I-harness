import { expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry, TOOL_FAILED } from "@i-harness/core-tools"
import { createOutputSpillGuard } from "../../output-retention/src/index.ts"
import { executeToolCalls } from "../src/index.ts"

it("actual scheduler failures retain the whole reason and project a canonical bounded result without executing again", async () => {
  const root = await mkdtemp(join(tmpdir(), "scheduler-retention-"))
  try {
    const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
    ctx.mount(createOutputSpillGuard(ctx, { spillRoot: root, boundSyntheticFailures: true }))
    let executions = 0, post = 0
    const reason = "actually failed after execution: " + "中文🙂".repeat(30000)
    tools.register({ name: "fail", description: "controlled body failure", inputSchema: {}, execute: async () => { executions++; throw new Error(reason) } })
    ctx.on("tools/post-execute", () => { post++ })
    await executeToolCalls(ctx, session, tools, [{ name: "fail", callId: "failed-once", args: {} }], { maxParallel: 1 })
    expect(executions).toBe(1); expect(post).toBe(0)
    const result = session.events.find(e => e.type === "tool/result")
    expect(result?.type).toBe("tool/result")
    if (result?.type !== "tool/result") throw new Error("missing retained result")
    const output = result.output as any
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(64000)
    expect(output.code).toBe(TOOL_FAILED)
    expect(output.error).toContain("actually failed after execution")
    expect(JSON.parse(await readFile(output.outputPaths[0], "utf8")).error).toBe(reason)
    expect(output.spill).toMatchObject({ retention: "temporary", maxAgeMs: 86400000, maxTotalBytes: 512 * 1024 * 1024 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

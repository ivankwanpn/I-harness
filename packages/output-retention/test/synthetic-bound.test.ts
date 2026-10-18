import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, TOOL_TIMEOUT, TOOL_FAILED } from "@i-harness/core-tools"
import { createTimeoutGuard } from "../../guard-timeout/src/index.ts"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOutputSpillGuard } from "../src/index.ts"

it("projects actual oversized timeout partials and scheduler failure reasons while preserving verdict and real images", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthetic-bound-"))
  try {
    const ctx = createContext(), registry = createToolRegistry(ctx)
    ctx.mount(createOutputSpillGuard(ctx, { spillRoot: root, boundSyntheticFailures: true }))
    ctx.mount(createTimeoutGuard(ctx))
    const image = { name: "real", dataBase64: "YQ==", width: 1, height: 1 }
    const full = "中文🙂".repeat(30000)
    let calls = 0
    registry.register({ name: "slow", description: "slow", inputSchema: {}, timeoutMs: 1, execute: async (_, exec) => { calls++; await new Promise<void>(resolve => exec.abortSignal!.addEventListener("abort", () => resolve(), { once: true })); return { partial: full, images: [image] } } })
    const { output } = await registry.execute({ name: "slow", args: {} }) as any
    expect(calls).toBe(1)
    expect(output.code).toBe(TOOL_TIMEOUT)
    expect(output.error).toContain("timed out")
    expect(output.images).toEqual([image])
    const { images, ...text } = output
    expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(64000)
    expect(JSON.parse(await readFile(output.outputPaths[0], "utf8"))).toMatchObject({ partial: full, code: TOOL_TIMEOUT })
    const reason = "provider rejected this call: " + full
    const failure = await ctx.cascade("tools/project-synthetic-result", { name: "failed", output: { code: TOOL_FAILED, error: reason } }, async () => ({ code: TOOL_FAILED, error: reason })) as any
    expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThanOrEqual(64000)
    expect(failure).toMatchObject({ code: TOOL_FAILED })
    expect(failure.error).toContain("provider rejected this call")
    expect(failure.outputPaths).toHaveLength(1)
    registry.register({ name: "collision", description: "data", inputSchema: {}, execute: async () => ({ code: TOOL_FAILED, partial: full }) })
    const collision = await registry.execute({ name: "collision", args: {} })
    expect(Buffer.byteLength(JSON.stringify(collision.output))).toBeLessThanOrEqual(64000)
    expect(collision.output).not.toHaveProperty("code")
  } finally { await rm(root, { recursive: true, force: true }) }
})

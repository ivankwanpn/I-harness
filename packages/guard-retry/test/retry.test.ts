import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createTimeoutGuard } from "@i-harness/guard-timeout"
import { createRetryGuard, backoffDelay, type RetryConfig } from "../src/index.ts"

interface BashLike { stdout: string; exitCode: number }

// A tool that times out until `attempts` invocations have happened, then succeeds.
// A "timeout" attempt WAITS for the abort signal (the real timeout wrapper then
// substitutes code: TOOL_TIMEOUT); a "success" attempt returns immediately so
// it completes before the fresh per-dispatch timer can fire.
function flakyTimeoutTool(timesToTimeout: number, attempts: number[]): Tool<{ x: number }, BashLike> {
  return {
    name: "flaky",
    description: "",
    inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
    timeoutMs: 30,
    execute: async (_args, exec) => {
      attempts.push(1)
      const signal = exec.abortSignal!
      if (attempts.length <= timesToTimeout) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return { stdout: "partial", exitCode: -1 }
      }
      return { stdout: "success", exitCode: 0 }
    },
  }
}

// Mount order matters: core-plugin runs cascade handlers in registration order
// with the FIRST-registered handler OUTERMOST (wraps the rest). The retry guard
// must therefore be mounted BEFORE the timeout guard so it sees the substituted
// TOOL_TIMEOUT raw value (the registry wraps in { name, output } only later).
function setup(tools: Tool[], retry?: RetryConfig) {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  for (const t of tools) registry.register(t)
  ctx.mount(createRetryGuard(ctx, retry)) // OUTER: sees TOOL_TIMEOUT
  ctx.mount(createTimeoutGuard(ctx))
  return { ctx, registry }
}

describe("guard-retry", () => {
  it("retries a TOOL_TIMEOUT and succeeds on the retry (fresh timer per re-dispatch)", async () => {
    const attempts: number[] = []
    const { registry } = setup([flakyTimeoutTool(1, attempts)], { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 })
    const result = await registry.execute({ name: "flaky", args: { x: 1 } })
    expect(attempts.length).toBe(2) // first times out, second succeeds
    expect((result.output as BashLike).stdout).toBe("success")
  })

  it("retries exhaust → final result still TOOL_TIMEOUT (pins the re-entrancy guard)", async () => {
    const attempts: number[] = []
    const { registry } = setup([flakyTimeoutTool(100, attempts)], { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 })
    const result = await registry.execute({ name: "flaky", args: { x: 1 } })
    // WITHOUT the re-entrancy guard the re-invoked cascade would nest the retry
    // handler and multiply attempts exponentially (2 retries → 7 attempts).
    expect(attempts.length).toBe(3) // 1 initial + 2 retries
    expect((result.output as { code: string }).code).toBe("TOOL_TIMEOUT")
  })

  it("a tool without timeoutMs passes through untouched", async () => {
    const plain: Tool = {
      name: "plain", description: "", inputSchema: {},
      execute: async () => ({ ok: true }),
    }
    const { registry } = setup([plain], { maxRetries: 2 })
    const result = await registry.execute({ name: "plain", args: {} })
    expect(result.output).toEqual({ ok: true })
  })

  it("a non-timeout error is NOT retried", async () => {
    const attempts: number[] = []
    const throwing: Tool = {
      name: "boom", description: "", inputSchema: {},
      execute: async () => { attempts.push(1); throw new Error("boom") },
    }
    const { registry } = setup([throwing], { maxRetries: 2 })
    await expect(registry.execute({ name: "boom", args: {} })).rejects.toThrow(/boom/)
    expect(attempts.length).toBe(1)
  })

  it("maxRetries 0 → no retry", async () => {
    const attempts: number[] = []
    const { registry } = setup([flakyTimeoutTool(100, attempts)], { maxRetries: 0, initialDelayMs: 1 })
    const result = await registry.execute({ name: "flaky", args: { x: 1 } })
    expect(attempts.length).toBe(1)
    expect((result.output as { code: string }).code).toBe("TOOL_TIMEOUT")
  })

  it("backoffDelay grows exponentially, jitters in range, and caps at maxDelayMs", () => {
    const config: RetryConfig = { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.1 }
    const d1 = backoffDelay(0, config)
    const d2 = backoffDelay(1, config)
    const d3 = backoffDelay(2, config)
    const d4 = backoffDelay(10, config) // 100 * 2^10 = 102400 → capped
    // jitter band [target*0.9, target*1.1] (targets 100, 200, 400; cap 1000)
    expect(d1).toBeGreaterThanOrEqual(90)
    expect(d1).toBeLessThanOrEqual(110)
    expect(d2).toBeGreaterThanOrEqual(180)
    expect(d2).toBeLessThanOrEqual(220)
    expect(d3).toBeGreaterThanOrEqual(360)
    expect(d3).toBeLessThanOrEqual(440)
    expect(d4).toBeLessThanOrEqual(1000)
    // deterministic with no jitter
    expect(backoffDelay(0, { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 })).toBe(100)
    expect(backoffDelay(2, { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 })).toBe(400)
    expect(backoffDelay(10, { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 })).toBe(1000)
  })

  it("mount ordering: retry INNER to timeout does NOT retry (TOOL_TIMEOUT not visible)", async () => {
    const attempts: number[] = []
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    registry.register(flakyTimeoutTool(100, attempts))
    ctx.mount(createTimeoutGuard(ctx)) // timeout FIRST = outer
    ctx.mount(createRetryGuard(ctx, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 })) // retry AFTER = inner
    const result = await registry.execute({ name: "flaky", args: { x: 1 } })
    // the inner retry handler sees the raw partial result (no TOOL_TIMEOUT) → no retry
    expect(attempts.length).toBe(1)
    expect((result.output as { code: string }).code).toBe("TOOL_TIMEOUT")
  })

  it("validates config fail-loud at construction", () => {
    const ctx = createContext()
    expect(() => createRetryGuard(ctx, { maxRetries: -1 })).toThrow(/maxRetries must be a non-negative integer/)
    expect(() => createRetryGuard(ctx, { maxRetries: 1.5 })).toThrow(/maxRetries must be a non-negative integer/)
    expect(() => createRetryGuard(ctx, { initialDelayMs: -5 })).toThrow(/initialDelayMs must be a non-negative integer/)
    expect(() => createRetryGuard(ctx, { maxDelayMs: 0.5 })).toThrow(/maxDelayMs must be a non-negative integer/)
    expect(() => createRetryGuard(ctx, { jitterRatio: 1 })).toThrow(/jitterRatio must be in \[0, 1\)/)
    expect(() => createRetryGuard(ctx, { jitterRatio: -0.1 })).toThrow(/jitterRatio must be in \[0, 1\)/)
  })

  it("defaults apply when no config is given", () => {
    // defaults: initialDelayMs 500, maxDelayMs 10_000, jitterRatio 0.1
    const d = backoffDelay(0, {})
    expect(d).toBeGreaterThanOrEqual(450)
    expect(d).toBeLessThanOrEqual(550)
  })
})

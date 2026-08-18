import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createShellTools } from "@i-harness/shell"
import { createExecService } from "@i-harness/exec"
import { createTimeoutGuard, TOOL_TIMEOUT } from "../src/index.ts"

// honors the signal: settles as soon as exec.abortSignal fires
const honoringTool: Tool = {
  name: "honor",
  description: "",
  inputSchema: {},
  timeoutMs: 40,
  execute: async (_args, exec) => {
    const signal = exec.abortSignal!
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener("abort", () => resolve(), { once: true })
    })
    return { output: "settled-after-abort" }
  },
}
const fastTool: Tool = {
  name: "fast",
  description: "",
  inputSchema: {},
  timeoutMs: 1000,
  execute: async () => ({ output: "fast-done" }),
}

describe("guard-timeout", () => {
  it("timed-out tool → TOOL_TIMEOUT marker at output top level", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    registry.register(honoringTool)
    ctx.mount(createTimeoutGuard(ctx))

    const result = await registry.execute({ name: "honor", args: {} })
    // registry wraps the cascade value in { name, output }; the marker reads at .code
    expect(result.output).toMatchObject({ code: TOOL_TIMEOUT })
    expect((result.output as { error?: string }).error).toContain("timed out after 40ms")
  })

  it("upstream abort is NOT our timeout: tool's own result passes through", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    const upstream = new AbortController()
    // Key ordering: registered BEFORE the guard mounts, so this handler runs
    // OUTSIDE the guard and the guard reads the injected signal as "upstream"
    // (not the guard's own derived signal).
    ctx.onCascade("tools/execute", async (dispatch, next) => {
      ;(dispatch as { exec: { abortSignal?: AbortSignal } }).exec.abortSignal = upstream.signal
      return next()
    })
    ctx.mount(createTimeoutGuard(ctx))
    const upstreamKillTool: Tool = {
      name: "kill",
      description: "",
      inputSchema: {},
      timeoutMs: 1000,
      execute: async (_args, exec) => {
        const signal = exec.abortSignal!
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return { output: "settled-via-upstream" }
      },
    }
    registry.register(upstreamKillTool)

    const executing = registry.execute({ name: "kill", args: {} })
    setTimeout(() => upstream.abort(), 20)
    const result = await executing

    expect(result.output).toEqual({ output: "settled-via-upstream" })
    expect((result.output as { code?: string }).code).not.toBe(TOOL_TIMEOUT)
  })

  it("no timeoutMs → tool untouched, exec.abortSignal stays undefined", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    let seenSignal: AbortSignal | undefined | "unset" = "unset"
    const plainTool: Tool = {
      name: "plain",
      description: "",
      inputSchema: {},
      execute: async (_args, exec) => {
        seenSignal = exec.abortSignal
        return { output: "plain-done" }
      },
    }
    registry.register(plainTool)
    ctx.mount(createTimeoutGuard(ctx))

    const result = await registry.execute({ name: "plain", args: {} })
    expect(result.output).toEqual({ output: "plain-done" })
    expect(seenSignal).toBeUndefined()
  })

  it("fast tool within budget → returned unchanged (timer cleared)", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    registry.register(fastTool)
    ctx.mount(createTimeoutGuard(ctx))

    const result = await registry.execute({ name: "fast", args: {} })
    expect(result.output).toEqual({ output: "fast-done" })
    expect((result.output as { code?: string }).code).toBeUndefined()
  })

  it("signal restored to original after a timed-out execute", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    let seenAfter: AbortSignal | undefined = "unset" as unknown as AbortSignal
    // OUTER observation handler: registered BEFORE the guard so it runs outside
    ctx.onCascade("tools/execute", async (dispatch, next) => {
      const out = await next()
      seenAfter = (dispatch as { exec: { abortSignal?: AbortSignal } }).exec.abortSignal
      return out
    })
    ctx.mount(createTimeoutGuard(ctx))
    registry.register(honoringTool)

    const result = await registry.execute({ name: "honor", args: {} })
    expect((result.output as { code?: string }).code).toBe(TOOL_TIMEOUT)
    // restored to the original empty exec.abortSignal (undefined)
    expect(seenAfter).toBeUndefined()
  })

  it("e2e: bash subprocess killed via forwarded abortSignal → TOOL_TIMEOUT", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    ctx.mount(createTimeoutGuard(ctx))
    const [bash] = createShellTools({ exec: createExecService(), timeoutMs: 300 })
    registry.register(bash)

    const start = Date.now()
    const result = await registry.execute({
      name: "bash",
      args: { command: 'node -e "setTimeout(()=>{}, 30000)"' },
    })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(10_000)
    expect(result.output).toMatchObject({ code: TOOL_TIMEOUT })
    expect((result.output as { error?: string }).error).toContain("timed out after 300ms")
  })

  it("a tool that honors the abort by REJECTING still yields TOOL_TIMEOUT (not a rejection)", async () => {
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    const rejectingTool: Tool = {
      name: "reject-on-abort",
      description: "",
      inputSchema: {},
      timeoutMs: 40,
      execute: async (_args, exec) => {
        const signal = exec.abortSignal!
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(new Error("killed"))
          else signal.addEventListener("abort", () => reject(new Error("killed")), { once: true })
        })
        return { output: "unreachable" }
      },
    }
    registry.register(rejectingTool)
    ctx.mount(createTimeoutGuard(ctx))

    // must RESOLVE with the structured marker, not reject the whole execute
    const result = await registry.execute({ name: "reject-on-abort", args: {} })
    expect(result.output).toMatchObject({ code: TOOL_TIMEOUT })
    expect((result.output as { error?: string }).error).toContain("timed out after 40ms")
  })
})

import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createRetryGuard } from "@i-harness/guard-retry"
import { createTimeoutGuard } from "@i-harness/guard-timeout"
import {
  HookBlockedError,
  HookConfigError,
  type HookContext,
  type HookHandlerSpec,
  type HooksConfig,
} from "../src/types.ts"
import { sha256File } from "../src/trust.ts"
import { createHookRegistry } from "../src/index.ts"
import {
  HookOutputError,
  HookTrustError,
  assertAllowed,
  runHookHandler,
  validateHookOutput,
} from "../src/runner.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "i-harness-hooks-"))
}

/** Write a handler script that: reads stdin JSON, resolves a per-kind reply, prints it. */
async function writeHandler(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name)
  await writeFile(file, body, "utf8")
  return file
}

const REPLY_SCRIPT = (stanza: string): string => `
const input = JSON.parse(require("fs").readFileSync(0, "utf8"))
process.stdout.write(JSON.stringify(${stanza}))
`

function jsonBody(reply: object): string {
  return REPLY_SCRIPT(JSON.stringify(reply))
}

async function configWith(dir: string, handlers: HooksConfig["handlers"]): Promise<string> {
  const file = join(dir, "hooks.json")
  await writeFile(file, JSON.stringify({ version: 1, handlers }, null, 2), "utf8")
  return file
}

describe("hook output validation (fail-closed)", () => {
  it("accepts the documented fields and rejects junk", () => {
    expect(validateHookOutput({ continue: false, stopReason: "because" }, "h1")).toEqual({ continue: false, stopReason: "because" })
    expect(validateHookOutput({ decision: "deny", reason: "no" }, "h1")).toEqual({ decision: "deny", reason: "no" })
    expect(() => validateHookOutput("nope", "h1")).toThrow(HookOutputError)
    expect(() => validateHookOutput({ decision: "maybe" } as unknown, "h1")).toThrow(HookOutputError)
    expect(() => validateHookOutput({ block: true } as unknown, "h1")).toThrow(/requires a reason/)
    expect(() => validateHookOutput({ extra: 1 } as unknown, "h1")).toThrow(HookOutputError)
  })

  it("assertAllowed maps deny/ask/block/continue:false to HookBlockedError", () => {
    expect(() => assertAllowed({ decision: "deny", reason: "x" }, "h1")).toThrowError(/x/)
    expect(() => assertAllowed({ decision: "ask" }, "h1")).toThrow(HookBlockedError)
    expect(() => assertAllowed({ block: true, reason: "y" }, "h1")).toThrowError(/y/)
    expect(() => assertAllowed({ continue: false, stopReason: "z" }, "h1")).toThrowError(/z/)
    expect(() => assertAllowed({}, "h1")).not.toThrow()
  })
})

describe("trust + runner", () => {
  it("sha256File + verifyHandlerTrust: mismatch throws HookTrustError", async () => {
    const dir = await tmpDir()
    const file = await writeHandler(dir, "h.js", jsonBody({}))
    const hash = await sha256File(file)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const spec: HookHandlerSpec = {
      id: "a", event: "pre-tool", type: "command", command: { cmd: process.execPath, args: [file] },
      trust: { script: file, sha256: hash },
    }
    await expect(runHookHandler(spec, { event: "pre-tool", tool: { name: "bash", args: {} } }, dir)).resolves.toEqual({})
    await expect(runHookHandler({ ...spec, trust: { script: file, sha256: "0".repeat(64) } }, { event: "pre-tool", tool: { name: "bash", args: {} } }, dir))
      .rejects.toBeInstanceOf(HookTrustError)
  })

  it("runner: non-zero exit / unparseable output / timeout are HookOutputError", async () => {
    const dir = await tmpDir()
    const boom = await writeHandler(dir, "boom.js", "process.exit(3)")
    const junk = await writeHandler(dir, "junk.js", "process.stdout.write('this is not json')")
    const sleepy = await writeHandler(dir, "sleepy.js", "setTimeout(() => process.exit(0), 60_000)")
    const mk = async (id: string, script: string): Promise<HookHandlerSpec> => ({
      id, event: "pre-tool", type: "command",
      command: { cmd: process.execPath, args: [script] },
      trust: { script, sha256: await sha256File(script) },
      timeoutMs: id === "sleepy" ? 100 : 1000,
    })
    const ctx: HookContext = { event: "stop", sessionId: "s1", finalText: "", turns: 1 }
    await expect(runHookHandler(await mk("boom", boom), ctx, dir)).rejects.toMatchObject({ code: "hook-output-invalid" })
    await expect(runHookHandler(await mk("junk", junk), ctx, dir)).rejects.toMatchObject({ code: "hook-output-invalid" })
    await expect(runHookHandler(await mk("sleepy", sleepy), ctx, dir)).rejects.toMatchObject({ code: "hook-output-invalid" })
  })
})

function makeTools(ctx: PluginContext): ReturnType<typeof createToolRegistry> {
  const tools = createToolRegistry(ctx)
  const register = (tool: Tool): void => { tools.register(tool) }
  register({
    name: "bash",
    description: "run a command",
    inputSchema: { type: "object", properties: {} },
    execute: async () => "ran",
    isReadOnly: false,
  })
  register({
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    execute: async () => "content",
    isReadOnly: true,
  })
  return tools
}

describe("registry wiring (createHookRegistry mounts)", () => {

  it("pre-tool block:true with reason blocks the tool (HookBlockedError); non-matching tools pass", async () => {
    const dir = await tmpDir()
    const script = await writeHandler(dir, "deny.js", jsonBody({ block: true, reason: "policy says no" }))
    const configPath = await configWith(dir, [{
      id: "deny-it", event: "pre-tool", type: "command", matcher: { tool: "bash" },
      command: { cmd: process.execPath, args: [script] },
      trust: { script, sha256: await sha256File(script) },
    }])
    const ctx = createContext()
    await createHookRegistry(ctx, { configPath, configDir: dir })
    const tools = makeTools(ctx)
    await expect(tools.execute({ name: "bash", args: {} })).rejects.toThrow(HookBlockedError)
    await expect(tools.execute({ name: "bash", args: {} })).rejects.toThrow(/policy says no/)
    await expect(tools.execute({ name: "read", args: { path: "a.txt" } })).resolves.toMatchObject({ name: "read" })
  })

  it("post-tool handlers run after the body and may block it (fail-closed)", async () => {
    const dir = await tmpDir()
    const script = await writeHandler(dir, "post.js", jsonBody({ block: true, reason: "output rejected" }))
    const configPath = await configWith(dir, [{
      id: "post-it", event: "post-tool", type: "command",
      command: { cmd: process.execPath, args: [script] },
      trust: { script, sha256: await sha256File(script) },
    }])
    const ctx = createContext()
    await createHookRegistry(ctx, { configPath, configDir: dir })
    const tools = makeTools(ctx)
    await expect(tools.execute({ name: "read", args: { path: "a.txt" } })).rejects.toThrow(/output rejected/)
  })

  it("permission handlers seed tools/pre-execute with a ToolDecision (deny → tool refused)", async () => {
    const dir = await tmpDir()
    const script = await writeHandler(dir, "perm.js", jsonBody({ decision: "deny", reason: "not allowed" }))
    const configPath = await configWith(dir, [{
      id: "perm", event: "permission", type: "command", matcher: { toolRegex: "^bash$" },
      command: { cmd: process.execPath, args: [script] },
      trust: { script, sha256: await sha256File(script) },
    }])
    const ctx = createContext()
    await createHookRegistry(ctx, { configPath, configDir: dir })
    const tools = makeTools(ctx)
    await expect(tools.execute({ name: "bash", args: {} })).rejects.toThrow(/denied/)
    // no permission handler matches "read" → it executes untouched
    await expect(tools.execute({ name: "read", args: { path: "a.txt" } })).resolves.toMatchObject({ name: "read" })
  })

  it("permission malformed output is fail-closed deny (never allow)", async () => {
    const dir = await tmpDir()
    const script = await writeHandler(dir, "bad-perm.js", "process.stdout.write('garbage')")
    const configPath = await configWith(dir, [{
      id: "bp", event: "permission", type: "command",
      command: { cmd: process.execPath, args: [script] },
      trust: { script, sha256: await sha256File(script) },
    }])
    const ctx = createContext()
    await createHookRegistry(ctx, { configPath, configDir: dir })
    const tools = makeTools(ctx)
    await expect(tools.execute({ name: "read", args: {} })).rejects.toThrow(/denied/)
  })

  it("prompt/submit: a blocking handler rejects the agent/pre-step emit", async () => {
    const dir = await tmpDir()
    const script = await writeHandler(dir, "prompt.js", jsonBody({ block: true, reason: "prompt blocked" }))
    const configPath = await configWith(dir, [{
      id: "p", event: "prompt/submit", type: "prompt",
      command: { cmd: process.execPath, args: [script] },
      trust: { script, sha256: await sha256File(script) },
    }])
    const ctx = createContext()
    await createHookRegistry(ctx, { configPath, configDir: dir })
    await expect(ctx.emit("agent/pre-step", { task: "do it", session: {} })).rejects.toThrow(/prompt blocked/)
  })

  it("stop: a blocking handler rejects the agent/stop emit", async () => {
    const dir = await tmpDir()
    const blocker = await writeHandler(dir, "stop.js", jsonBody({ block: true, reason: "stop blocked" }))
    const configPath = await configWith(dir, [{
      id: "s", event: "stop", type: "agent",
      command: { cmd: process.execPath, args: [blocker] },
      trust: { script: blocker, sha256: await sha256File(blocker) },
    }])
    const ctx = createContext()
    await createHookRegistry(ctx, { configPath, configDir: dir })
    await expect(ctx.emit("agent/stop", { sessionId: "s1", finalText: "x", turns: 1 })).rejects.toThrow(/stop blocked/)
  })

  it("trust-broken handlers: gates deny (fail-closed), observers are reported only", async () => {
    const dir = await tmpDir()
    const gate = await writeHandler(dir, "gate.js", jsonBody({ decision: "allow" }))
    const observer = await writeHandler(dir, "obs.js", jsonBody({}))
    const configPath = await configWith(dir, [
      {
        id: "g", event: "pre-tool", type: "command",
        command: { cmd: process.execPath, args: [gate] },
        trust: { script: gate, sha256: "0".repeat(64) }, // broken trust on purpose
      },
      {
        id: "o", event: "notification", type: "agent",
        command: { cmd: process.execPath, args: [observer] },
        trust: { script: observer, sha256: "0".repeat(64) },
      },
    ])
    const report = vi.fn()
    const ctx = createContext()
    const registry = await createHookRegistry(ctx, { configPath, configDir: dir, report })
    const tools = makeTools(ctx)
    // gate: the handler would allow, but trust is broken → fail-closed block
    await expect(tools.execute({ name: "read", args: {} })).rejects.toThrow(HookBlockedError)
    // observer: reported, never fatal
    await registry.fire("notification", { message: "hi" })
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0]![0]).toBeInstanceOf(Error)
  })

  it("a missing default config yields zero handlers (hosts without hooks)", async () => {
    const dir = await tmpDir()
    const ctx = createContext()
    // default-derived path (no explicit configPath) under an empty configDir
    const registry = await createHookRegistry(ctx, { configDir: dir })
    expect(registry.handlers()).toEqual([])
  })

  it("an unreadable EXPLICIT configPath throws fail-closed", async () => {
    const dir = await tmpDir()
    const ctx = createContext()
    await expect(createHookRegistry(ctx, { configPath: join(dir, "hooks.json") })).rejects.toThrow(HookConfigError)
  })
})

describe("hooks end-to-end (agent + hooks + tools)", () => {
  it("a pre-tool handler that blocks 'read' fails the agent turn fail-closed", async () => {
    const dir = await tmpDir()
    const script = await writeHandler(dir, "no-read.js", jsonBody({ block: true, reason: "read disabled" }))
    const configPath = await configWith(dir, [{
      id: "nr", event: "pre-tool", type: "command", matcher: { tool: "read" },
      command: { cmd: process.execPath, args: [script] },
      trust: { script, sha256: await sha256File(script) },
    }])
    const ctx = createContext()
    await createHookRegistry(ctx, { configPath, configDir: dir })
    const tools = makeTools(ctx)
    const { createAgent } = await import("@i-harness/core-agent")
    const { createSession } = await import("@i-harness/core-session")
    const { createMockClient } = await import("@i-harness/llm-mock")
    const agent = createAgent(ctx, {
      session: createSession(),
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      ]),
      systemPrompt: "you are a coding agent",
    })
    await expect(agent.run("do it")).rejects.toThrow(/read disabled/)
  })

  it("an allow-everything hooks config leaves the turn untouched (happy path through the seams)", async () => {
    const dir = await tmpDir()
    const allow = await writeHandler(dir, "allow.js", jsonBody({ continue: true }))
    const configPath = await configWith(dir, [{
      id: "allow", event: "pre-tool", type: "command",
      command: { cmd: process.execPath, args: [allow] },
      trust: { script: allow, sha256: await sha256File(allow) },
    }])
    const ctx = createContext()
    await createHookRegistry(ctx, { configPath, configDir: dir })
    const tools = makeTools(ctx)
    const { createAgent } = await import("@i-harness/core-agent")
    const { createSession } = await import("@i-harness/core-session")
    const { createMockClient } = await import("@i-harness/llm-mock")
    const agent = createAgent(ctx, {
      session: createSession(),
      tools,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
        { role: "assistant", text: "Report: read done" },
      ]),
      systemPrompt: "you are a coding agent",
    })
    const result = await agent.run("do it")
    expect(result.finalText).toBe("Report: read done")
  })
})

// M51 B1: guard-retry RE-DISPATCHES through the tools/execute cascade, so the
// hooks cascade handler used to run its pre/post-tool pair once per attempt.
// The contract is exactly one pair per logical call, independent of retry
// count and mount order — while the retry still re-enters the cascade (the
// timeout guard must re-arm; a direct tool.execute would break that).
describe("M51 B1: retry re-dispatch runs the hook pair exactly once", () => {
  interface BashLike { stdout: string; exitCode: number }

  // A tool that times out once (waits for the abort signal) then succeeds.
  // M52 L2: also records each attempt's exec.abortSignal — the timeout guard
  // swaps in a FRESH controller per cascade frame, so a retry that re-enters
  // the cascade arms a new (non-aborted) signal; a bare tool.execute reuses
  // the restored upstream (here: undefined).
  function flakyTimeoutTool(
    attempts: number[],
    signals: Array<AbortSignal | undefined>,
  ): Tool<{ x: number }, BashLike> {
    return {
      name: "flaky",
      description: "",
      inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      timeoutMs: 30,
      execute: async (_args, exec) => {
        attempts.push(1)
        signals.push(exec.abortSignal)
        if (attempts.length <= 1) {
          const signal = exec.abortSignal ?? new AbortController().signal
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

  /** A handler that appends IH_HOOK_EVENT to a counter file; "deny-second"
   * blocks every pre-tool invocation after the first (a stateful gate). */
  async function counterHandler(dir: string, counter: string, mode: "allow" | "deny-second"): Promise<string> {
    return writeHandler(dir, "counter.cjs", `
const fs = require("fs")
const counter = ${JSON.stringify(counter)}
const event = process.env.IH_HOOK_EVENT
const seen = fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\\n").filter(Boolean) : []
fs.appendFileSync(counter, event + "\\n")
const deny = ${JSON.stringify(mode)} === "deny-second" && event === "pre-tool" && seen.filter((l) => l === "pre-tool").length >= 1
process.stdout.write(deny ? JSON.stringify({ block: true, reason: "stateful gate: already allowed once" }) : "{}")
`)
  }

  function counterLines(counter: string): string[] {
    return existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter((l) => l !== "") : []
  }

  // Registration order = cascade order (first-registered OUTERMOST); the
  // timeout guard is always innermost so retry observes the TOOL_TIMEOUT.
  async function setupRetryHooks(opts: {
    dir: string
    counter: string
    mode: "allow" | "deny-second"
    order: "hooks-outer" | "retry-outer"
    attempts: number[]
    // M52 L2: per-attempt exec.abortSignal (fresh controller ⇔ cascade re-entry).
    signals: Array<AbortSignal | undefined>
    // M52 L2: one push per tools/execute cascade ENTRY. A retry that re-enters
    // the cascade (so the timeout guard re-arms) pushes once per attempt; a
    // retry that calls tool.execute directly never pushes the second frame.
    cascadeFrames: number[]
  }): Promise<ReturnType<typeof createToolRegistry>> {
    const script = await counterHandler(opts.dir, opts.counter, opts.mode)
    const sha = await sha256File(script)
    const configPath = await configWith(opts.dir, [
      { id: "pre", event: "pre-tool", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256: sha } },
      { id: "post", event: "post-tool", type: "command", command: { cmd: process.execPath, args: [script] }, trust: { script, sha256: sha } },
    ])
    const ctx = createContext()
    // M52 L2: spy cascade handler — counts cascade entries independent of the
    // retry guard's own re-dispatch bookkeeping.
    ctx.onCascade("tools/execute", async (_input, next) => {
      opts.cascadeFrames.push(1)
      return next()
    })
    const registry = createToolRegistry(ctx)
    registry.register(flakyTimeoutTool(opts.attempts, opts.signals))
    const retry = (): void => ctx.mount(createRetryGuard(ctx, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 }))
    if (opts.order === "hooks-outer") {
      await createHookRegistry(ctx, { configPath, configDir: opts.dir })
      retry()
    } else {
      retry()
      await createHookRegistry(ctx, { configPath, configDir: opts.dir })
    }
    ctx.mount(createTimeoutGuard(ctx))
    return registry
  }

  for (const order of ["hooks-outer", "retry-outer"] as const) {
    it(`pre-tool/post-tool run exactly once across a retry (${order})`, async () => {
      const dir = await tmpDir()
      const counter = join(dir, "counter.txt")
      const attempts: number[] = []
      const signals: Array<AbortSignal | undefined> = []
      const cascadeFrames: number[] = []
      const registry = await setupRetryHooks({ dir, counter, mode: "allow", order, attempts, signals, cascadeFrames })
      const result = await registry.execute({ name: "flaky", args: { x: 1 } })
      expect((result.output as BashLike).stdout).toBe("success")
      // M52 L2: attempts=2 alone does not pin the re-dispatch path — a retry
      // that called tool.execute directly would also run the body twice. Pin
      // the cascade RE-ENTRY: the spy sees one frame per attempt, and the
      // second attempt's abortSignal is the timeout guard's freshly armed
      // controller (attempt 1's was aborted by the timeout).
      expect(attempts.length).toBe(2)
      expect(cascadeFrames).toHaveLength(2)
      expect(signals).toHaveLength(2)
      expect(signals[0]?.aborted).toBe(true)
      expect(signals[1]).toBeDefined()
      expect(signals[1]?.aborted).toBe(false)
      expect(signals[1]).not.toBe(signals[0])
      expect(counterLines(counter).filter((l) => l === "pre-tool")).toHaveLength(1)
      expect(counterLines(counter).filter((l) => l === "post-tool")).toHaveLength(1)
    })

    it(`a stateful pre-tool gate is not re-run by the retry (${order})`, async () => {
      const dir = await tmpDir()
      const counter = join(dir, "counter.txt")
      const attempts: number[] = []
      const signals: Array<AbortSignal | undefined> = []
      const cascadeFrames: number[] = []
      const registry = await setupRetryHooks({ dir, counter, mode: "deny-second", order, attempts, signals, cascadeFrames })
      const result = await registry.execute({ name: "flaky", args: { x: 1 } })
      expect((result.output as BashLike).stdout).toBe("success")
      expect(attempts.length).toBe(2)
      expect(counterLines(counter).filter((l) => l === "pre-tool")).toHaveLength(1)
    })
  }
})

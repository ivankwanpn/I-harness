import { describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
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

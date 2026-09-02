import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runHeadless } from "../src/run.ts"
import { main, parseModel, GEMINI_MODEL_CONTEXTS, BEDROCK_MODEL_CONTEXTS } from "../src/index.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createApprovalPolicy } from "@i-harness/guard-approval"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createFileBackedSessionQuery, closeSessionQueries } from "@i-harness/session-query"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { CompactionConfig } from "@i-harness/compaction"
import type { RetryConfig } from "@i-harness/guard-retry"
import type { ShellRetentionOptions } from "@i-harness/shell"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { probeBwrap } from "@i-harness/sandbox-local"

// M23: observe — without altering — the createSessionCoordinator call surface
// so the CLI's ownership-lock wiring is assertable. The wrapper DELEGATES to
// the real factory (every other test in this file keeps the genuine
// implementation and behavior); it only records the arguments index.ts passes.
// The full two-process conflict e2e lands in M25 (per plan).
const coordinatorFactoryCalls = vi.hoisted(() => ({ list: [] as unknown[][] }))
vi.mock("@i-harness/session-persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@i-harness/session-persistence")>()
  const real = actual.createSessionCoordinator as (...args: unknown[]) => unknown
  return {
    ...actual,
    createSessionCoordinator: (...args: unknown[]) => {
      coordinatorFactoryCalls.list.push(args)
      return real(...args)
    },
  }
})

// M29: observe — without altering — the createFileBackedSessionQuery call
// surface so the CLI's file-backed wiring is assertable (the real builder is
// used; only the arguments are recorded; the M10b tests keep the genuine
// createFileBackedSessionQuery implementation).
const fileBackedCalls = vi.hoisted(() => ({ list: [] as unknown[][] }))
vi.mock("@i-harness/session-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@i-harness/session-query")>()
  const real = actual.createFileBackedSessionQuery as (...args: unknown[]) => unknown
  return {
    ...actual,
    createFileBackedSessionQuery: (...args: unknown[]) => {
      fileBackedCalls.list.push(args)
      return real(...args)
    },
  }
})

// Poll a read until it returns a defined value (bounded). The subagent
// persistence wrappers save fire-and-forget (M6), so document reads need to
// wait for eventual durability. A read that throws (e.g. JSON.parse on a file
// caught mid-write) is treated as "not ready yet" and retried.
async function pollUntil<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    try {
      last = await fn()
    } catch {
      last = undefined
    }
    if (last !== undefined) return last
    await new Promise((r) => setTimeout(r, 20))
  }
  return last
}

describe("headless CLI (M2)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-m2-"))
    writeFileSync(join(dir, "data.txt"), "old line")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("runs read→write→report through the full pipeline (fs tools + guard)", async () => {
    const result = await runHeadless("edit data.txt", {
      workspace: dir,
      approveAll: true, // guard-approval ask is auto-approved in headless mode
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "data.txt" } }] },
        { role: "assistant", toolCalls: [{ name: "write", args: { path: "data.txt", text: "hello" } }] },
        { role: "assistant", text: "报告：已修改" },
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toContain("报告")
    expect(readFileSync(join(dir, "data.txt"), "utf-8")).toBe("hello")
  })

  it("denies a dangerous command without approval (guard-approval active)", async () => {
    const result = await runHeadless("run dangerous", {
      workspace: dir,
      approveAll: false, // no approval → fail closed
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: "rm -rf data.txt" } }] },
      ],
    })
    expect(result.exitCode).not.toBe(0)
  })

  it("returns non-zero exit code on a tool error", async () => {
    const result = await runHeadless("read missing", {
      workspace: dir,
      approveAll: true,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "nope.txt" } }] },
      ],
    })
    expect(result.exitCode).not.toBe(0)
  })

  it("cross-scope: parent policy gates a child-scope registry dispatch (fail closed)", async () => {
    // parent ctx mounts the approval policy + a shell tool registry
    const parentCtx = createContext()
    const parentTools = createToolRegistry(parentCtx)
    createApprovalPolicy(parentCtx, parentTools, { workspace: dir })
    parentTools.register({
      name: "bash",
      description: "",
      inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => ({ stdout: "ran", exitCode: 0 }),
    })

    // child scope registers its OWN registry + bash-like write tool
    const childCtx = parentCtx.scope.mount()
    const childTools = createToolRegistry(childCtx)
    let bodyRan = false
    childTools.register({
      name: "bash",
      description: "",
      inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => {
        bodyRan = true
        return { stdout: "ran", exitCode: 0 }
      },
    })

    // dispatch through the CHILD registry with NO answerer anywhere
    await expect(childTools.execute({ name: "bash", args: { command: "rm -rf data.txt" } })).rejects.toThrow(/approval|denied/i)
    expect(bodyRan).toBe(false)
  })

  it("cross-scope negative control: parent answerer auto-approves a child dispatch", async () => {
    const parentCtx = createContext()
    const parentTools = createToolRegistry(parentCtx)
    createApprovalPolicy(parentCtx, parentTools, { workspace: dir })
    registerApprovalAnswerer(parentCtx, async () => ({ approved: true }))
    parentTools.register({
      name: "bash",
      description: "",
      inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => ({ stdout: "ran", exitCode: 0 }),
    })

    const childCtx = parentCtx.scope.mount()
    const childTools = createToolRegistry(childCtx)
    childTools.register({
      name: "bash",
      description: "",
      inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => ({ stdout: "ran", exitCode: 0 }),
    })

    // the parent answerer (inherited via the service chain) must approve the
    // dangerous child dispatch — proving the gate is the policy, not a broken
    // dispatch path
    const result = await childTools.execute({ name: "bash", args: { command: "rm -rf data.txt" } })
    expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
  })

  it("tool_search promotes a deferred tool in the headless pipeline", async () => {
    const result = await runHeadless("find the grep tool", {
      workspace: dir,
      approveAll: true,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "tool_search", args: { query: "search patterns" } }] },
        { role: "assistant", toolCalls: [{ name: "grep", args: { pattern: "x", path: "data.txt" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    expect(result.exitCode).toBe(0)
  })
  describe("headless CLI M10b session-query tools (M29: file-backed, jsonl store)", () => {
    it("session_search finds previously written session content", async () => {
      // M29: the store root is the workspace — the query surface is the
      // file-backed index over the jsonl store (reconcile-on-search).
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      await coordinator.create({ sessionId: "main" })
      await coordinator.append("main", [{ type: "user/message", text: "the purple unicorn fixed the parser" }])
      const sessionQuery = createFileBackedSessionQuery({ storeRoot: dir })
      try {
        const result = await runHeadless("find it", {
          workspace: dir,
          approveAll: true,
          coordinator,
          sessionQuery,
          sessionId: "main",
          mockScript: [
            { role: "assistant", toolCalls: [{ name: "session_search", args: { query: "purple unicorn" } }] },
            { role: "assistant", text: "ok" },
          ],
        })
        expect(result.exitCode).toBe(0)
        const resultEvent = result.session!.events.find((e) => e.type === "tool/result") as { output: { hits: { sessionId: string; snippet: string }[] } } | undefined
        expect(resultEvent).toBeDefined()
        const hits = resultEvent!.output.hits
        expect(hits.length).toBe(1)
        expect(hits[0]!.sessionId).toBe("main")
        expect(hits[0]!.snippet).toContain("unicorn")
      } finally {
        closeSessionQueries()
      }
    })

    it("lineage shows the parent/child structure", async () => {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      await coordinator.create({ sessionId: "parent" })
      await coordinator.create({ sessionId: "child", parentSession: "parent", delegationDepth: 1, origin: "subagent" })
      const sessionQuery = createFileBackedSessionQuery({ storeRoot: dir })
      try {
        const result = await runHeadless("lineage", {
          workspace: dir,
          approveAll: true,
          coordinator,
          sessionQuery,
          sessionId: "parent",
          mockScript: [
            { role: "assistant", toolCalls: [{ name: "lineage", args: { session_id: "parent", direction: "children" } }] },
            { role: "assistant", text: "ok" },
          ],
        })
        expect(result.exitCode).toBe(0)
        const resultEvent = result.session!.events.find((e) => e.type === "tool/result") as { output: { nodes: { sessionId: string; parentSession?: string }[] } } | undefined
        expect(resultEvent).toBeDefined()
        const nodes = resultEvent!.output.nodes
        expect(nodes.map((n) => n.sessionId)).toEqual(["child"])
        expect(nodes[0]!.parentSession).toBe("parent")
      } finally {
        closeSessionQueries()
      }
    })

    it("tools are not mounted when no sessionQuery is provided", async () => {
      const result = await runHeadless("no query", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "session_search", args: { query: "x" } }] },
          { role: "assistant", text: "ok" },
        ],
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.error).toContain("unknown tool: session_search")
      // Without sessionQuery, session_search is unknown because the tool is not mounted.
    })
  })

  describe("headless CLI M11 compaction", () => {
    it("auto-compacts a long session and completes normally", async () => {
      // Production-representative shape: maxTokens (20) << threshold (50), so
      // the summary alone can never re-cross the threshold — no hot loop.
      const compact: CompactionConfig = { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 20 }
      // Inline structural model: every stream() call (agent turn OR the shared
      // summarizer call) yields the same long text, so the e2e is deterministic
      // (a script-based createMockClient would be consumed by the summarizer).
      const model: ModelClient = {
        async *stream() {
          yield { type: "text/chunk", text: "compacted work summary line ".repeat(20) }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("z".repeat(300), { // ~75 tokens ≥ 50 threshold at step 1
        workspace: dir, approveAll: true, compact, model,
      })
      expect(result.exitCode).toBe(0)
      const summary = result.session!.events.find((e) => e.type === "compaction/summary")
      expect(summary).toBeDefined()
      // the summary is model-visible in the final derived surface
      const msgs = deriveMessages(result.session!)
      expect(msgs[0]).toEqual({ role: "user", content: (summary as { text: string }).text })
      expect(result.finalText).toContain("compacted work summary line")
    })

    it("resumes a persisted compacted session (load tolerates compaction events)", async () => {
      // Seed a compacted session over a temp jsonl store. Seqs are explicit
      // because the jsonl backend stores each event payload verbatim; the
      // summary's shadowedSeqs [0] then hides the old user/message so the
      // resume surface leads with the summary. Without the KNOWN_EVENT_TYPES
      // registration this load path hard-fails (SessionFormatUnsupportedError).
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      await coordinator.create({ sessionId: "main" })
      await coordinator.append("main", [
        { type: "user/message", text: "old work", seq: 0 },
        { type: "compaction/start", seq: 1 },
        { type: "compaction/summary", text: "COMPACTED HISTORY", shadowedSeqs: [0], seq: 2 },
        { type: "compaction/end", seq: 3 },
      ])
      try {
        const result = await runHeadless("continue", {
          workspace: dir,
          approveAll: true,
          coordinator,
          resumeSessionId: "main",
          mockScript: [{ role: "assistant", text: "continuing" }],
        })
        expect(result.exitCode).toBe(0)
        // C1 regression: the resume load path must tolerate compaction events
        // (they are registered KNOWN_EVENT_TYPES), and the projection leads
        // with the restored summary.
        expect(deriveMessages(result.session!)[0]).toEqual({ role: "user", content: "COMPACTED HISTORY" })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("no compact config → no compaction events, behavior unchanged", async () => {
      const result = await runHeadless("plain", { workspace: dir, approveAll: true, mockScript: [{ role: "assistant", text: "ok" }] })
      expect(result.exitCode).toBe(0)
      expect(result.session!.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
    })
  })
})

describe("CLI main + entry guard", () => {
  it("main() prints the final text and returns 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "hello"])
      expect(code).toBe(0)
      expect(log).toHaveBeenCalledWith("ok")
    } finally {
      log.mockRestore()
    }
  })

  it("runs main when the CLI module is executed as the entry point", () => {
    // spawn a real node process so the module-level entry guard fires:
    // `node --import tsx apps/cli/src/index.ts run "hello"` must print and exit 0.
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url))
    const res = spawnSync(process.execPath, ["--import", "tsx", entry, "run", "hello"], {
      cwd: repoRoot,
      encoding: "utf-8",
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("ok")
  })

  it("parseModel applies per-provider defaultModel for bare provider specs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = parseModel("deepseek", "k")
    const it = client.stream({ messages: [], tools: [], systemPrompt: "" } as never)[Symbol.asyncIterator]()
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain("api.deepseek.com")
    expect(JSON.parse(init.body as string).model).toBe("deepseek-chat")
    await it.return?.()
  })

  it("parseModel gemini built-in profile: GenAI endpoint + x-goog-api-key + bare defaultModel", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = parseModel("gemini:gemini-2.5-pro", "sk-g")
    const it = client.stream({ messages: [], tools: [], systemPrompt: "" } as never)[Symbol.asyncIterator]()
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse")
    expect((init.headers as Record<string, string> | undefined)?.["x-goog-api-key"]).toBe("sk-g")
    expect((init.headers as Record<string, string> | undefined)?.["Authorization"]).toBeUndefined()
    await it.return?.()
    // bare spec → the built-in profile's defaultModel
    vi.stubGlobal("fetch", fetchMock)
    const client2 = parseModel("gemini", "sk-g")
    const it2 = client2.stream({ messages: [], tools: [], systemPrompt: "" } as never)[Symbol.asyncIterator]()
    await it2.next()
    expect(fetchMock.mock.calls[1]![0]).toContain("/gemini-2.5-pro:streamGenerateContent")
    await it2.return?.()
  })

  it("parseModel built-in bedrock profile constructs key-less", () => {
    const client = parseModel("bedrock:anthropic.claude-x", "")
    expect(typeof client.stream).toBe("function")
  })

  it("M30 modelContexts: the built-in gemini/bedrock catalogs carry context windows", () => {
    expect(GEMINI_MODEL_CONTEXTS["gemini-2.5-pro"]?.contextWindow).toBe(1_048_576)
    expect(GEMINI_MODEL_CONTEXTS["gemini-1.5-pro"]?.contextWindow).toBe(2_097_152)
    expect(BEDROCK_MODEL_CONTEXTS["anthropic.claude-3-5-sonnet-20241022"]?.contextWindow).toBe(200_000)
  })

  it("main() fails loud for gemini without --api-key (M30 gate: no mock fallback)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const code = await main(["node", "i-harness", "run", "hello", "--model", "gemini:gemini-2.5-pro"])
      expect(code).toBe(1)
      expect(err).toHaveBeenCalledWith("--model requires --api-key KEY")
    } finally {
      err.mockRestore()
    }
  })
})

// M24b (spec §5 integration): the two e2e probes — skills (deferred retrieval)
// and workflows (single background job observed through the existing job_output)
// — driven through the REAL headless pipeline (run.ts wiring included).
describe("headless CLI M24b skills + workflow mount", () => {
  it("skill_search + skill_get work in a real run (deferred retrieval)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m24b-skills-"))
    try {
      mkdirSync(join(dir, "skills", "alpha"), { recursive: true })
      writeFileSync(
        join(dir, "skills", "alpha", "SKILL.md"),
        "---\nname: alpha\ndescription: Rebuild the search indexer cache.\n---\n\nRun scripts/rebuild.sh first, then warm the cache with scripts/warm.js.",
      )
      const result = await runHeadless("apply the alpha skill", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "skill_search", args: { query: "rebuild indexer" } }] },
          { role: "assistant", toolCalls: [{ name: "skill_get", args: { name: "alpha" } }] },
          { role: "assistant", text: "skill applied" },
        ],
      })
      expect(result.exitCode).toBe(0)
      // The tool RESULTS are observable on the session log — the search found
      // the sample skill and skill_get returned its usable body.
      const results = result.session!.events.filter((e) => e.type === "tool/result") as { name: string; output: unknown }[]
      const search = results.find((e) => e.name === "skill_search")
      expect(JSON.stringify(search?.output)).toContain("alpha")
      const get = results.find((e) => e.name === "skill_get")
      expect(JSON.stringify(get?.output)).toContain("scripts/rebuild.sh")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("workflow_run returns a job_id; job_output observes it (M24b)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m24b-wf-"))
    try {
      mkdirSync(join(dir, "workflow"))
      // Windows-safe step command: node is on PATH (the .cmd-shim concern from
      // T2 review rules out pnpm/other .cmd shims); the command is TOKENIZED
      // (no shell syntax) — see the workflow_run tool description.
      writeFileSync(
        join(dir, "workflow", "hello.yml"),
        [
          "name: hello",
          "description: Print a greeting then finish.",
          "steps:",
          "  - name: greet",
          `    command: node -e "console.log('wf hello from step')"`,
        ].join("\n"),
      )
      const result = await runHeadless("run the hello workflow", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "workflow_run", args: { name: "hello" } }] },
          { role: "assistant", toolCalls: [{ name: "job_output", args: { job_id: "workflow-1", wait: true, timeout_ms: 10_000 } }] },
          { role: "assistant", text: "workflow finished" },
        ],
      })
      expect(result.exitCode).toBe(0)
      const results = result.session!.events.filter((e) => e.type === "tool/result") as { name: string; output: unknown }[]
      // workflow_run returned the single-job id for the run.
      const run = results.find((e) => e.name === "workflow_run")
      expect(JSON.stringify(run?.output)).toContain("workflow-1")
      // job_output collected it: step stdout + progress line + final status.
      const out = results.find((e) => e.name === "job_output")
      const outJson = JSON.stringify(out?.output)
      expect(outJson).toContain("wf hello from step")
      expect(outJson).toContain("[step 1/1 greet] ok")
      expect(outJson).toContain("[status: completed]")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("headless CLI subagent + fs-search mount (M3-C finish)", () => {

  it("mounts the subagent tools into the harness registry (job_list callable)", async () => {
    // Deterministic mount probe: drive a headless run whose only tool call is
    // job_list (a read-only subagent tool, no child spawn, so no shared-model
    // race). registerSubagent runs inside the try before createAgent, so any
    // mount error surfaces as exitCode 1; a successful job_list dispatch proves
    // the 11 subagent tools are mounted and executable in the pipeline. The
    // spawn_agent reachability variant is intentionally NOT used here: the
    // spawned child consumes the SHARED destructive mock cassette, exhausting
    // the main agent's next stream (spec §3 race).
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m3cf-"))
    try {
      const result = await runHeadless("list jobs", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "job_list", args: {} }] },
          { role: "assistant", text: "ok" },
        ],
      })
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("glob is a real deferred tool discoverable by tool_search", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m3cf-"))
    try {
      const result = await runHeadless("find the glob tool", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "tool_search", args: { query: "find files by pattern" } }] },
          { role: "assistant", toolCalls: [{ name: "glob", args: { pattern: "**/*.txt" } }] },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("headless CLI persistence (M4)", () => {
  it("runHeadless with a coordinator persists the session to a JSONL file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m4-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      const result = await runHeadless("hello", {
        workspace: dir,
        approveAll: true,
        sessionId: id,
        coordinator,
      })
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resume restores the persisted history into the model request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m4-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      await coordinator.append(id, [
        { type: "turn/start" },
        { type: "user/message", text: "earlier question" },
        { type: "assistant/message", text: "earlier answer" },
        { type: "turn/end" },
      ])

      const seen: LLMRequest[] = []
      const recordingModel: ModelClient = {
        async *stream(request: LLMRequest) {
          seen.push(request)
          yield { type: "text/chunk", text: "continued" }
          yield { type: "end" }
        },
      }

      const result = await runHeadless("continue here", {
        workspace: dir,
        approveAll: true,
        resumeSessionId: id,
        coordinator,
        model: recordingModel,
      })
      expect(result.exitCode).toBe(0)
      expect(seen.length).toBeGreaterThan(0)
      const texts = seen[0]!.messages.map((m) => m.content).filter((c) => c.length > 0)
      expect(texts).toContain("earlier question")
      expect(texts).toContain("earlier answer")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resume restores the session header alongside the history (G7)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-g7-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      // Seed the lineage header through the coordinator's create meta (the
      // coordinator rebuilds session.header from it on load — same path the
      // main resume uses).
      const { id } = await coordinator.create({ parentSession: "main-0", delegationDepth: 0, origin: "subagent" })
      await coordinator.append(id, [
        { type: "turn/start" },
        { type: "user/message", text: "old question" },
        { type: "turn/end" },
      ])
      const result = await runHeadless("continue", {
        workspace: dir,
        approveAll: true,
        resumeSessionId: id,
        coordinator,
        mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(result.exitCode).toBe(0)
      // G7: the resumed run's session adopts the persisted lineage header —
      // without it the subagent max_depth guard would always read depth 0
      // after a resume.
      expect(result.session!.header).toMatchObject({ parentSession: "main-0", origin: "subagent" })
      // the history is still restored alongside the header
      expect(result.session!.events.some((e) => e.type === "user/message" && e.text === "old question")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resume with a missing session id resolves cleanly instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m4-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      // no session file was created → coordinator.load rejects; runHeadless must
      // turn that into a clean { exitCode: 1, error } result, not a throw.
      const result = await runHeadless("hello", {
        workspace: dir,
        approveAll: true,
        resumeSessionId: "missing",
        coordinator,
      })
      expect(result.exitCode).toBe(1)
      expect(result.error).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("main() with --session-dir creates a session file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m4-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        const code = await main(["node", "i-harness", "run", "hello", "--session-dir", dir])
        expect(code).toBe(0)
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
        expect(files).toHaveLength(1)
      } finally {
        log.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("headless CLI persistence (M5, M29: JSONL only)", () => {
  it("runHeadless with a jsonl coordinator persists to the store (no sessions.db)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      const result = await runHeadless("hello", {
        workspace: dir,
        approveAll: true,
        sessionId: id,
        coordinator,
      })
      expect(result.exitCode).toBe(0)
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      expect(files).toHaveLength(1)
      // M29: the sqlite persistence artifact no longer exists anywhere
      expect(existsSync(join(dir, "sessions.db"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resume restores the persisted history into the model request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      await coordinator.append(id, [
        { type: "turn/start" },
        { type: "user/message", text: "earlier question" },
        { type: "assistant/message", text: "earlier answer" },
        { type: "turn/end" },
      ])

      const seen: LLMRequest[] = []
      const recordingModel: ModelClient = {
        async *stream(request: LLMRequest) {
          seen.push(request)
          yield { type: "text/chunk", text: "continued" }
          yield { type: "end" }
        },
      }

      const result = await runHeadless("continue here", {
        workspace: dir,
        approveAll: true,
        resumeSessionId: id,
        coordinator,
        model: recordingModel,
      })
      expect(result.exitCode).toBe(0)
      expect(seen.length).toBeGreaterThan(0)
      const texts = seen[0]!.messages.map((m) => m.content).filter((c) => c.length > 0)
      expect(texts).toContain("earlier question")
      expect(texts).toContain("earlier answer")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("main() with --session-dir creates a .jsonl session file (jsonl-only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        const code = await main(["node", "i-harness", "run", "hello", "--session-dir", dir])
        expect(code).toBe(0)
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
        expect(files).toHaveLength(1)
        expect(existsSync(join(dir, "sessions.db"))).toBe(false)
      } finally {
        log.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("default (no flag) still writes a .jsonl file (M4 regression guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        const code = await main(["node", "i-harness", "run", "hello", "--session-dir", dir])
        expect(code).toBe(0)
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
        expect(files).toHaveLength(1)
      } finally {
        log.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("headless CLI subagent state persistence (M6)", () => {
  it("persists subagent state via the coordinator document API on a run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m6-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      // Deterministic spawn driver: a SHARED mock cassette would be consumed by
      // the spawned child (destructive-cassette race, M3-C), exhausting the main
      // agent's next stream. A fresh model client yields the spawn tool call
      // first, then plain text for every later stream (child + main agent).
      let calls = 0
      const spawnModel: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "done" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("delegate", {
        workspace: dir,
        approveAll: true,
        sessionId: id,
        coordinator,
        model: spawnModel,
      })
      expect(result.exitCode).toBe(0)
      // Wrapper saves are fire-and-forget (Task 2 design), so durability is
      // eventual: poll until the document shows a settled job. This also proves
      // the child's terminal save completed before teardown (no ENOENT race).
      const state = await pollUntil(async () => {
        const doc = await coordinator.getDocument(id)
        if (!doc) return undefined
        const jobs = (doc as { jobs: { status: string }[] }).jobs
        return jobs.length > 0 && jobs.every((j) => j.status !== "running") ? doc : undefined
      })
      expect(state).toBeDefined()
      expect((state as { jobs: unknown[] }).jobs.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("resume restores a user-overridden role and settled jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m6-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      await coordinator.append(id, [
        { type: "turn/start" }, { type: "user/message", text: "first" },
        { type: "assistant/message", text: "first answer" }, { type: "turn/end" },
      ])
      // Persist a state document with a custom role + a settled job.
      await coordinator.putDocument(id, {
        formatVersion: 1,
        jobs: [{ id: "subagent-1", owner: "root", kind: "subagent", label: "old", status: "completed", output: "done", terminal: true }],
        agentTable: [],
        roles: [{ name: "custom", description: "d", systemPrompt: "custom prompt", tools: ["read"] }],
      })
      // Deterministic resume driver: first stream yields a spawn with the
      // restored custom role; every later stream (child + main agent) is text.
      // If restoreState skipped the custom role, spawn_agent throws
      // `unknown role: custom` and no "helper" job ever appears.
      let calls = 0
      const resumeModel: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper", agent_type: "custom" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "continued" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("continue", {
        workspace: dir,
        approveAll: true,
        resumeSessionId: id,
        coordinator,
        model: resumeModel,
      })
      expect(result.exitCode).toBe(0)
      // The spawn's terminal save snapshots the full restored state: the
      // restored job (label "old") AND the new spawn (label "helper", only
      // possible if the restored custom role was effective). Poll until both.
      const state = await pollUntil(async () => {
        const doc = await coordinator.getDocument(id)
        if (!doc) return undefined
        const labels = (doc as { jobs: { label: string; status: string }[] }).jobs.map((j) => j.label)
        const allSettled = (doc as { jobs: { status: string }[] }).jobs.every((j) => j.status !== "running")
        if (!allSettled) return undefined
        return labels.includes("old") && labels.includes("helper") ? doc : undefined
      })
      expect(state).toBeDefined()
      expect((state as { roles: { name: string }[] }).roles.map((r) => r.name)).toContain("custom")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("headless CLI durable child sessions (M8)", () => {
  it("spawn persists the child session log (child-<uuid> file with events)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m8-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      // Deterministic driver: first stream yields spawn_agent; later streams (child + main) are text.
      let calls = 0
      const spawnModel: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "done" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("delegate", {
        workspace: dir, approveAll: true, sessionId: id, coordinator, model: spawnModel,
      })
      expect(result.exitCode).toBe(0)
      const childIds = (await coordinator.list()).filter((sid) => sid.startsWith("child-"))
      expect(childIds.length).toBe(1)
      const { session } = await coordinator.load(childIds[0]!)
      expect(session.header).toMatchObject({ origin: "subagent", parentSession: id })
      expect(session.events.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("resume keeps the child sessionId link in the restored registry snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m8-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      let calls = 0
      const spawnModel: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "done" }
          yield { type: "end" }
        },
      }
      const first = await runHeadless("delegate", { workspace: dir, approveAll: true, sessionId: id, coordinator, model: spawnModel })
      expect(first.exitCode).toBe(0)
      const childId = (await coordinator.list()).find((sid) => sid.startsWith("child-"))
      expect(childId).toBeDefined()
      // Resumed run: first stream sends a message to the restored child (which
      // only works if the resume-load loop installed the live mirror session),
      // later streams are text.
      let resumeCalls = 0
      const resumeModel: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = resumeCalls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "send_message", args: { target: "root/helper", message: "ping" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "continued" }
          yield { type: "end" }
        },
      }
      const second = await runHeadless("continue", { workspace: dir, approveAll: true, resumeSessionId: id, coordinator, model: resumeModel })
      expect(second.exitCode).toBe(0)
      // The restored child's mirror session received the durable inbox event.
      const reloaded = await coordinator.load(childId!)
      expect(reloaded.session.events.some((e) => e.type === "subagent/inbox" && e.message === "ping")).toBe(true)
      // The post-resume registry snapshot still carries the child sessionId link.
      const after = await coordinator.getDocument(id)
      const agents = (after as { agentTable: { path: string; sessionId?: string }[] }).agentTable
      expect(agents.find((a) => a.path === "root/helper")?.sessionId).toBe(childId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("fresh run: the main agent spawns a child then sends it a message; the inbox event lands in the child log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m8-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      // Deterministic driver. The spawned child shares the model client, so the
      // first stream AFTER spawn (n=1) is the CHILD's own stream (M3-C race) —
      // it must be text, not a tool call. The main agent's send_message is n=2.
      let calls = 0
      const model: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper" } } }
            yield { type: "end" }
            return
          }
          if (n === 1) {
            yield { type: "text/chunk", text: "child done" }
            yield { type: "end" }
            return
          }
          if (n === 2) {
            yield { type: "tool_call", call: { name: "send_message", args: { target: "root/helper", message: "ping" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "done" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("delegate", { workspace: dir, approveAll: true, sessionId: id, coordinator, model })
      expect(result.exitCode).toBe(0)
      const childId = (await coordinator.list()).find((sid) => sid.startsWith("child-"))
      expect(childId).toBeDefined()
      const { session } = await coordinator.load(childId!)
      const inbox = session.events.filter((e) => e.type === "subagent/inbox")
      expect(inbox.map((e) => e.message)).toEqual(["ping"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("headless CLI multi-turn subagents (M9)", () => {
  it("followup_task drives a second turn on the child's durable session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m9-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      // Deterministic driver: n=0 spawn_agent (fork none), n=2 followup_task,
      // every other stream (child turns + main) is text.
      let calls = 0
      const model: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper", fork_turns: "none" } } }
            yield { type: "end" }
            return
          }
          if (n === 2) {
            yield { type: "tool_call", call: { name: "followup_task", args: { target: "root/helper", message: "again" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "ok" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("delegate", { workspace: dir, approveAll: true, sessionId: id, coordinator, model })
      expect(result.exitCode).toBe(0)
      const childId = (await coordinator.list()).find((sid) => sid.startsWith("child-"))
      expect(childId).toBeDefined()
      const { session } = await coordinator.load(childId!)
      // Two turns (initial + followup): two user messages, no fork seed.
      const userMessages = session.events.filter((e) => e.type === "user/message")
      expect(userMessages.map((e) => e.text)).toEqual(["do it", "again"])
      expect(session.events.filter((e) => e.type === "turn/start")).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("resume_agent cold-resumes a child and continues the conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m9-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      // Run 1: spawn (fork none) + followup → child log has 2 turns.
      let calls = 0
      const run1Model: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper", fork_turns: "none" } } }
            yield { type: "end" }
            return
          }
          if (n === 2) {
            yield { type: "tool_call", call: { name: "followup_task", args: { target: "root/helper", message: "again" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "ok" }
          yield { type: "end" }
        },
      }
      const first = await runHeadless("delegate", { workspace: dir, approveAll: true, sessionId: id, coordinator, model: run1Model })
      expect(first.exitCode).toBe(0)
      const childId = (await coordinator.list()).find((sid) => sid.startsWith("child-"))
      expect(childId).toBeDefined()
      // Run 2: resume → resume_agent then followup_task → child log gains a 3rd turn.
      let resumeCalls = 0
      const run2Model: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = resumeCalls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "resume_agent", args: { target: "root/helper" } } }
            yield { type: "end" }
            return
          }
          if (n === 1) {
            yield { type: "tool_call", call: { name: "followup_task", args: { target: "root/helper", message: "third" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "ok" }
          yield { type: "end" }
        },
      }
      const second = await runHeadless("continue", { workspace: dir, approveAll: true, resumeSessionId: id, coordinator, model: run2Model })
      expect(second.exitCode).toBe(0)
      // The followup "third" turn is driven in the background (serialization
      // chain is NOT awaited by runHeadless), so wait for the third user
      // message durably before asserting the exact conversation.
      const childMsgs = await pollUntil(async () => {
        const { session: s } = await coordinator.load(childId!)
        const msgs = s.events.filter((e) => e.type === "user/message")
        return msgs.length >= 3 ? msgs : undefined
      })
      expect(childMsgs?.map((e) => e.text)).toEqual(["do it", "again", "third"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("headless CLI M10a guards (timeout + repeat-reminder)", () => {
  it("bash that outlives shellTimeoutMs → TOOL_TIMEOUT marker on tool/result, run completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m10a-"))
    try {
      const start = performance.now()
      const result = await runHeadless("slow", {
        workspace: dir,
        approveAll: true,
        shellTimeoutMs: 300,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "bash", args: { command: 'node -e "setTimeout(()=>{}, 30000)"' } }] },
          { role: "assistant", text: "done" },
        ],
      })
      const elapsed = performance.now() - start
      // the guard must cut the 30s command short, not hang the headless run
      expect(elapsed).toBeLessThan(10_000)
      expect(result.exitCode).toBe(0)
      expect(result.finalText).toBe("done")
      // the session's tool/result carries the substituted output with the
      // TOOL_TIMEOUT marker at the TOP level of `output` (registry wraps the
      // guard's substituted value in { name, output })
      const bashResult = result.session?.events.find((e) => e.type === "tool/result" && e.name === "bash")
      expect(bashResult).toBeDefined()
      const output = (bashResult as { output: { code?: string; error?: string } }).output
      expect(output.code).toBe("TOOL_TIMEOUT")
      expect(output.error).toContain("timed out after 300ms")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("four identical bash calls → plugin user/message consecutive-times reminder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m10a-"))
    try {
      const result = await runHeadless("repeat", {
        workspace: dir,
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
          { role: "assistant", toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
          { role: "assistant", toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
          { role: "assistant", toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0)
      const pluginMessages = result.session?.events.filter(
        (e) => e.type === "user/message" && (e as { source?: { kind: string } }).source?.kind === "plugin",
      )
      expect(pluginMessages).toBeDefined()
      expect(pluginMessages!.some((e) => (e as { text: string }).text.includes("consecutive times"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("headless CLI M12 retry + retention", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-m12-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("retries a timed-out bash call and succeeds on the retry", async () => {
    // Deterministic: the command touches a guard file on the FIRST run and sleeps
    // (so it times out), then runs fast on later invocations.
    const flag = join(dir, "attempt")
    const command = `node -e "const fs=require('fs');const f='${flag.replace(/\\/g, "/")}';if(!fs.existsSync(f)){fs.writeFileSync(f,'1');setTimeout(()=>{},5000)}"`
    const retry: RetryConfig = { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 }
    const result = await runHeadless("retry", {
      workspace: dir,
      approveAll: true,
      // 300 to match the M10a timeout tests: the RETRY attempt must complete
      // (node startup + script) inside this budget, and 200ms flakes on slow CI.
      shellTimeoutMs: 300,
      retry,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command } }] },
        { role: "assistant", text: "done" },
      ],
    })
    expect(result.exitCode).toBe(0)
    const resultEvent = result.session!.events.find((e) => e.type === "tool/result") as { output: { stdout?: string; code?: string } } | undefined
    expect(resultEvent).toBeDefined()
    // The command ran at least once (the guard file exists), and the final
    // tool/result is the successful RETRY, not the TOOL_TIMEOUT marker the
    // first (sleeping) attempt produced. Without M12 retry wiring, output.code
    // stays "TOOL_TIMEOUT" and this discriminates the feature from
    // behavior-unchanged.
    expect(existsSync(flag)).toBe(true)
    expect(resultEvent!.output.code).toBeUndefined()
    expect(resultEvent!.output.stdout ?? "").not.toContain("timed out")
  })

  it("shellRetention caps a verbose bash output with the truncated marker", async () => {
    const retention: ShellRetentionOptions = { maxBytes: 100 }
    const result = await runHeadless("verbose", {
      workspace: dir,
      approveAll: true,
      shellRetention: retention,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: "node -e \"process.stdout.write('y'.repeat(5000))\"" } }] },
        { role: "assistant", text: "ok" },
      ],
    })
    expect(result.exitCode).toBe(0)
    const resultEvent = result.session!.events.find((e) => e.type === "tool/result") as { output: { stdout: string; truncated?: unknown } } | undefined
    expect(resultEvent!.output.stdout.length).toBeLessThanOrEqual(100)
    expect(resultEvent!.output.truncated).toBeDefined()
  })

  it("no retry/shellRetention → existing behavior (regression)", async () => {
    const result = await runHeadless("plain", { workspace: dir, approveAll: true, mockScript: [{ role: "assistant", text: "ok" }] })
    expect(result.exitCode).toBe(0)
  })
})

describe("headless CLI M13 parallel tool calls", () => {
  it("M13: runs two parallel-safe read calls of one step and commits both results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m13-"))
    try {
      const target = join(dir, "a.txt")
      await writeFile(target, "alpha", "utf-8")
      const result = await runHeadless("read two files", {
        workspace: dir,
        approveAll: true,
        maxParallelToolCalls: 2,
        mockScript: [
          { role: "assistant", toolCalls: [
            { name: "read", args: { path: "a.txt" } },
            { name: "read", args: { path: "a.txt" } },
          ]},
          { role: "assistant", text: "read both" },
        ],
      })
      expect(result.exitCode).toBe(0)
      const reads = result.session!.events.filter((e) => e.type === "tool/result" && e.name === "read")
      expect(reads).toHaveLength(2)
      for (const ev of reads) {
        expect((ev as { output: { content: string } }).output.content).toBe("alpha")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("M13: rejects a non-integer maxParallelToolCalls with exitCode 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m13-"))
    try {
      const result = await runHeadless("hi", { workspace: dir, maxParallelToolCalls: 1.5 })
      expect(result.exitCode).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("headless CLI M14 multimodal (image-bearing user message)", () => {
  it("M14: agent completes when the session starts with an image-bearing user message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m14-"))
    try {
      const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      // Drive the agent with a pre-seeded session carrying an image-bearing
      // user/message (the host owns the session; the harness is headless).
      const session = createSession()
      append(session, { type: "user/message", text: "describe this", images: [{ mediaType: "image/png", dataBase64: PNG }] })
      // Pin the model-visible surface: the seeded image must reach the request
      // as an image part. A fresh-session run (no `session` option) would drop
      // the seed — the model would only see the bare task text — so this is
      // what makes the test discriminate the host-seeded path. The mock client
      // beneath stays the scripted cassette for the run itself.
      const seen: LLMRequest[] = []
      const recordingModel: ModelClient = {
        async *stream(request: LLMRequest) {
          seen.push(request)
          yield* createMockClient([{ role: "assistant", text: "a tiny png" }]).stream(request)
        },
      }
      const result = await runHeadless("describe this", {
        workspace: dir,
        approveAll: true,
        model: recordingModel,
        session,
      })
      expect(result.exitCode).toBe(0)
      expect(result.finalText).toBe("a tiny png")
      const firstUser = seen[0]!.messages.find((m) => m.role === "user")
      const parts = Array.isArray(firstUser!.content) ? firstUser!.content : []
      const imagePart = parts.find((p) => p.type === "image")
      expect(imagePart).toBeDefined()
      expect((imagePart as { image: { mediaType: string; dataBase64: string } }).image).toEqual({
        mediaType: "image/png",
        dataBase64: PNG,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("M16 CLI sandbox wiring", () => {
  it("runHeadless accepts --sandbox read-only and mounts the policy (no crash)", async () => {
    // The real bwrap deny e2e lives in Task 6; here we assert the wiring:
    // the sandbox option is accepted, the CLI mounts the sandbox provider and
    // policy without crashing, and a simple run completes. The rendered policy
    // context is pinned on the model request too — that is the only observable
    // wiring effect on this host, and it keeps the RED phase a real runtime
    // failure (vitest transpiles TS without typechecking, so an unknown
    // HeadlessOptions field alone would silently pass).
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m16-"))
    try {
      const seen: LLMRequest[] = []
      const recordingModel: ModelClient = {
        async *stream(request: LLMRequest) {
          seen.push(request)
          yield { type: "text/chunk", text: "ok" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("hello", {
        workspace: dir,
        sandbox: "read-only",
        approveAll: true,
        model: recordingModel,
      })
      expect(result.exitCode).toBe(0)
      expect(result.finalText).toBe("ok")
      expect(seen[0]!.systemPrompt).toContain("read-only")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runHeadless accepts --sandbox danger-full-access (passthrough, no provider composed)", async () => {
    // The fail-closed counterpart: danger-full-access must NOT compose a
    // provider (exec passthrough) — the prompt tells the model the sandbox is
    // off, and the run completes like the unconfigured path.
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m16-"))
    try {
      const seen: LLMRequest[] = []
      const recordingModel: ModelClient = {
        async *stream(request: LLMRequest) {
          seen.push(request)
          yield { type: "text/chunk", text: "ok" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("hello", {
        workspace: dir,
        sandbox: "danger-full-access",
        approveAll: true,
        model: recordingModel,
      })
      expect(result.exitCode).toBe(0)
      expect(seen[0]!.systemPrompt).toContain("danger-full-access")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // M16 final-review C1(b): end-to-end confinement — on a Linux host with a
  // working bwrap, a read-only sandbox must make a workspace write FAIL (the
  // bash tool's command runs confined; denial signatures mark it). Same
  // skip-guard pattern as bwrap.e2e.ts (the probe is the REAL gate
  // createLocalSandbox uses, so blocked-namespaces hosts skip instead of RED).
  it.skipIf(!(process.platform === "linux" && probeBwrap()))("sandbox read-only denies a workspace write end-to-end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m16-c1-"))
    try {
      const result = await runHeadless("write in the workspace", {
        workspace: dir,
        sandbox: "read-only",
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "bash", args: { command: `echo hi > "${dir}/c1.txt"` } }] },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0) // the tool failed, but the harness run completes
      const bashResult = result.session?.events.find((e) => e.type === "tool/result" && e.name === "bash")
      const output = (bashResult as { output: { stdout?: string; stderr?: string; error?: string; exitCode?: number } } | undefined)?.output
      // The deny observable: the confined command exited nonzero (the write was
      // refused), and the bwrap deny marker is present on the tool stderr (same
      // marker the bwrap.e2e asserts).
      expect(output?.exitCode).not.toBe(0)
      const text = `${output?.stdout ?? ""}\n${output?.stderr ?? ""}\n${output?.error ?? ""}`
      expect(text.toLowerCase()).toContain("read-only file system")
      expect(existsSync(join(dir, "c1.txt"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // M16w final-review (win32 composition): on a Windows host the CLI must
  // compose the REAL windows-acl backend (createLocalSandbox throws
  // SandboxUnavailableError("no windows ACL backend composed") without it),
  // so ANY confined bash/pwsh dispatch aborts the run — this guards the
  // compose wiring (a bash-less run would not discriminate: confine is only
  // reached at shell-tool dispatch). One bash call is the minimal probe: the
  // backend is composed and the runner starts (the deny behavior itself is
  // e2e'd inside the windows-acl package). The win32 backend requires koffi,
  // which cannot load off Windows, so the test skips everywhere else.
  it.skipIf(process.platform !== "win32")("win32: composes the windows-acl backend — confined run completes without SandboxUnavailableError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m16w-"))
    try {
      const result = await runHeadless("hello", {
        workspace: dir,
        sandbox: "read-only",
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
          { role: "assistant", text: "done" },
        ],
      })
      // The confined command may fail on THIS host (the tool result carries
      // the failure) — the assertion is the harness run completing, i.e. the
      // composition never turned confinement into SandboxUnavailableError.
      expect(result.exitCode).toBe(0)
      expect(result.error ?? "").not.toContain("sandbox")
      expect(result.finalText).toBe("done")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// M17: the fake MCP server runs as a REAL subprocess (SDK Server +
// StdioServerTransport), so its .mjs script imports the SDK by absolute file
// URL — the handshake (initialize → tools/list → tools/call) is the real
// protocol, not a mock (same approach as packages/mcp-client/test/client.test.ts
// Task 3). The SDK is installed under @i-harness/mcp-client (pnpm-symlinked to
// packages/mcp-client/node_modules), NOT under apps/cli, so the URL resolves
// from the package's own install dir rather than ../node_modules.
const MCP_SDK_BASE_URL = new URL("../../../packages/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url)
const MCP_SDK_SERVER_URL = new URL("server/index.js", MCP_SDK_BASE_URL).href
const MCP_SDK_STDIO_URL = new URL("server/stdio.js", MCP_SDK_BASE_URL).href
const MCP_SDK_TYPES_URL = new URL("types.js", MCP_SDK_BASE_URL).href

// Minimal MCP server exposing one echo tool (SDK 1.30: setRequestHandler
// requires real zod schemas from types.js, not plain objects).
const MCP_FAKE_SERVER = `
import { Server } from ${JSON.stringify(MCP_SDK_SERVER_URL)}
import { StdioServerTransport } from ${JSON.stringify(MCP_SDK_STDIO_URL)}
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(MCP_SDK_TYPES_URL)}
const server = new Server({ name: "fake", version: "0.1.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: "ok:" + req.params.arguments?.text }],
}))
await server.connect(new StdioServerTransport())
`

function writeFakeMcpServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "i-harness-m17-"))
  const script = join(dir, "fake-mcp-server.mjs")
  writeFileSync(script, MCP_FAKE_SERVER)
  return script
}

describe("M17 CLI mcp integration", () => {
  // Real end-to-end: runHeadless mounts the stdio server (real subprocess),
  // the mock model calls the registered mcp__fake__echo tool, and the echo
  // response must land in the session's tool/result event — mount → register
  // → dispatch → call, all through the real protocol. RED phase: HeadlessOptions.mcp
  // is unknown, so the tool call fails with "unknown tool" → exitCode 1.
  it("runHeadless mounts mcp servers and the agent can use an mcp tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m17-"))
    try {
      const result = await runHeadless("use the mcp echo tool", {
        workspace: dir,
        approveAll: true, // mcp tools are non-readOnly → ask → auto-approve
        mcp: [{ transport: "stdio", serverName: "fake", command: process.execPath, args: [writeFakeMcpServer()] }],
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "mcp__fake__echo", args: { text: "hello mcp" } }] },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0)
      expect(result.finalText).toBe("done")
      const echo = result.session!.events.find((e) => e.type === "tool/result" && e.name === "mcp__fake__echo")
      expect(echo).toBeDefined()
      expect(JSON.stringify((echo as { output: unknown }).output)).toContain("ok:hello mcp")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // Unmount observable: the mcp-client reservation on serverName dies only in
  // runHeadless's finally. A second run with the SAME serverName must mount
  // cleanly; if the first run leaked the mount, run 2 throws "already
  // reserved" → exitCode 1. (RED phase: mounts are ignored, so both runs
  // trivially succeed — this test only discriminates once wiring exists.)
  it("unmounts the mcp server after the run (serverName reservation released)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m17-"))
    try {
      const cfg = { transport: "stdio" as const, serverName: "fake", command: process.execPath, args: [writeFakeMcpServer()] }
      const first = await runHeadless("one", {
        workspace: dir, approveAll: true, mcp: [cfg], mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(first.exitCode).toBe(0)
      const second = await runHeadless("two", {
        workspace: dir, approveAll: true, mcp: [cfg], mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(second.exitCode).toBe(0)
      expect(second.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// M18: the fake LSP server also runs as a REAL subprocess (like M17's fake
// MCP), speaking the LSP Content-Length framing over stdio: parse
// "Content-Length: N\r\n\r\n<json>" frames from stdin, answer requests with
// the same framing on stdout, and exit after the `exit` notification. The
// script is fully self-contained (no imports — Buffer/TextDecoder/process are
// globals) and prints NOTHING else to stdout, so the client's frame parser
// never sees stray bytes (the lsp package's MessageDecoder would fail-closed
// and tear the connection down on undecodable data).
const FAKE_LSP_SERVER = `
const decoder = new TextDecoder("utf-8")
let buffer = Buffer.alloc(0)

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf-8")
  const header = Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "ascii")
  process.stdout.write(Buffer.concat([header, body]))
}

function handle(msg) {
  if (typeof msg.method !== "string") return
  if (msg.id === undefined || msg.id === null) {
    // notification: didOpen/didClose/initialized need no response; exit ends us
    if (msg.method === "exit") setImmediate(() => process.exit(0))
    return
  }
  const id = msg.id
  const params = msg.params ?? {}
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      capabilities: {
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
      },
    } })
    return
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: null })
    return
  }
  if (msg.method === "textDocument/definition") {
    // ECHO the requested uri back so the rendered (workspace-relative) path
    // matches the temp file the client actually queried.
    const uri = params?.textDocument?.uri ?? "file:///unknown"
    send({ jsonrpc: "2.0", id, result: {
      locations: [{ uri, range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } }],
    } })
    return
  }
  if (msg.method === "textDocument/hover") {
    send({ jsonrpc: "2.0", id, result: { contents: { kind: "markdown", value: "--- hover: TYPE ---" } } })
    return
  }
  if (msg.method === "textDocument/references") {
    send({ jsonrpc: "2.0", id, result: { locations: [] } })
    return
  }
  if (msg.method === "textDocument/diagnostic") {
    send({ jsonrpc: "2.0", id, result: {
      items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "syntax error", source: "fake" }],
    } })
    return
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + msg.method } })
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n")
    if (headerEnd === -1) break
    const headerText = buffer.subarray(0, headerEnd).toString("ascii")
    const m = /^Content-Length:\\s*(\\d+)$/im.exec(headerText)
    if (!m) process.exit(1)
    const length = Number(m[1])
    if (buffer.length < headerEnd + 4 + length) break
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length)
    buffer = buffer.subarray(headerEnd + 4 + length)
    let msg
    try { msg = JSON.parse(decoder.decode(body)) } catch { process.exit(1) }
    handle(msg)
  }
})
`

function writeFakeLspServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "i-harness-m18-server-"))
  const script = join(dir, "fake-lsp-server.mjs")
  writeFileSync(script, FAKE_LSP_SERVER)
  return script
}

describe("M18 CLI lsp integration", () => {
  // Real end-to-end: runHeadless mounts the LSP server (real stdio subprocess
  // speaking Content-Length framing), the mock model calls the registered lsp
  // tool, and the definition location must land in the session's tool/result
  // event — mount → register → dispatch → query, all through the real
  // protocol. The fake server echoes the requested uri back, so the rendered,
  // workspace-relative path matches the temp file (a.ts). RED phase:
  // HeadlessOptions.lsp is unknown → the lsp tool never mounts → the mock call
  // fails with "unknown tool" → exitCode 1.
  it("runHeadless mounts lsp servers and the agent can use the lsp tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m18-"))
    try {
      writeFileSync(join(dir, "a.ts"), "const x = 1\n")
      const result = await runHeadless("use the lsp tool", {
        workspace: dir,
        approveAll: true, // keep approveAll like M17: the agent calls through dispatch
        lsp: [{ serverName: "fake", command: process.execPath, args: [writeFakeLspServer()], cwd: dir, languages: [".ts"] }],
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "lsp", args: { operation: "goToDefinition", file_path: "a.ts", line: 1, character: 4 } }] },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0)
      expect(result.finalText).toBe("done")
      const lsp = result.session!.events.find((e) => e.type === "tool/result" && e.name === "lsp")
      expect(lsp).toBeDefined()
      // range start 0:3 → 1:4; end 0:7 → 1:8 (1-based render), path relative to workspace
      expect(JSON.stringify((lsp as { output: unknown }).output)).toContain("a.ts:1:4-1:8")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // Unmount observable: the lsp module-level serverName reservation dies only
  // in runHeadless's finally. A second run with the SAME serverName must mount
  // cleanly; if the first run leaked the mount, run 2 throws "already
  // reserved" → exitCode 1. (RED phase: mounts are ignored, so both runs
  // trivially succeed — this test only discriminates once wiring exists.)
  it("unmounts the lsp server after the run (serverName reservation released)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m18-"))
    try {
      const cfg = { serverName: "fake", command: process.execPath, args: [writeFakeLspServer()], cwd: dir, languages: [".ts"] as string[] }
      const first = await runHeadless("one", {
        workspace: dir, approveAll: true, lsp: [cfg], mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(first.exitCode).toBe(0)
      const second = await runHeadless("two", {
        workspace: dir, approveAll: true, lsp: [cfg], mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(second.exitCode).toBe(0)
      expect(second.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("M19 CLI team integration", () => {
  // Real end-to-end: runHeadless mounts the agent-team domain (mountAgentTeams
  // from Task 10) with a coordinator so teammates get durable child-<uuid>
  // sessions. The mock model (SHARED with the child) calls spawn_teammate; the
  // roster → realSpawnChild bridge → subagent spawnChild creates a REAL child
  // agent that runs its own (mock-model) turn — the happy-path real spawn that
  // Task 10's lifecycle test only stubbed. The child shares the model client,
  // so its initial turn consumes the NEXT script step (M3-C race — same as
  // M8's durable-child test), then the lead produces its final message.
  // RED phase: HeadlessOptions.team is unknown → spawn_teammate never mounts
  // → the call fails with "unknown tool" → exitCode 1.
  it("runHeadless mounts team tools and the agent can use spawn_teammate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m19-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      const result = await runHeadless("use the team", {
        workspace: dir,
        approveAll: true,
        team: {},
        sessionId: id,
        coordinator,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "spawn_teammate", args: { name: "helper", description: "d", prompt: "do the work" } }] },
          // step consumed by the spawned child's own (mock-model) turn
          { role: "assistant", text: "child done" },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0)
      expect(result.finalText).toBe("done")
      const spawn = result.session!.events.find((e) => e.type === "tool/result" && e.name === "spawn_teammate")
      expect(spawn).toBeDefined()
      expect(JSON.stringify((spawn as { output: unknown }).output)).toContain("helper")
      // The spawned teammate is a REAL durable child session (lineage header).
      const childIds = (await coordinator.list()).filter((sid) => sid.startsWith("child-"))
      expect(childIds.length).toBe(1)
      // Drain the trailing fire-and-forget subagent-state save (triggered by
      // the team unmount's table.remove right after close()) before rmSync —
      // otherwise the temp dir vanishes under the pending putDocument rename
      // and the background-failure reporter spams stderr ENOENT noise.
      await coordinator.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // Unmount observable: the agent-team reservation (one team per run lives in
  // a module-level set) dies only in runHeadless's finally. A second run with
  // team mounted must mount cleanly; if the first run leaked the mount, run 2
  // throws "only one team per run" → exitCode 1. (RED phase: no wiring → the
  // team never mounts and both runs trivially succeed — this test only
  // discriminates once wiring exists.)
  it("unmounts the team after the run (team reservation released)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m19-"))
    try {
      const first = await runHeadless("one", {
        workspace: dir, approveAll: true, team: {}, mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(first.exitCode).toBe(0)
      const second = await runHeadless("two", {
        workspace: dir, approveAll: true, team: {}, mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(second.exitCode).toBe(0)
      expect(second.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("M23 CLI session ownership lock wiring", () => {
  // Wiring observable (per brief: the two-process conflict e2e is M25): main()
  // must pass the coordinator's opt-in ownership lease to BOTH backends, with
  // lockRoot = the session STORE directory (not the workspace) so lock files
  // share the store's lifecycle. The delegating module mock records the real
  // factory's arguments; the coordinator itself is genuine, so this test also
  // proves a lock-enabled run completes (jsonl create → acquire → close →
  // release) instead of failing on its own wiring.
  it("main wires lock { enabled: true, lockRoot: <store dir> } into the coordinator backend", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "i-harness-m23-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      const before = coordinatorFactoryCalls.list.length
      try {
        expect(await main(["node", "i-harness", "run", "hello", "--session-dir", storeDir])).toBe(0)
      } finally {
        log.mockRestore()
        err.mockRestore()
      }
      const calls = coordinatorFactoryCalls.list.slice(before) as [unknown, { lock?: { enabled?: boolean; lockRoot?: string } } | undefined][]
      expect(calls).toHaveLength(1)
      const [backend, opts] = calls[0]!
      expect(backend).toBeDefined()
      expect(opts?.lock?.enabled).toBe(true)
      // lockRoot = the session store dir (jsonl store root), NOT the workspace
      expect(opts?.lock?.lockRoot).toBe(storeDir)
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  }, 10_000)
})

// M25 (spec §2.2): --telemetry enables the independent host event stream as
// JSONL lines on stdout (default off). Telemetry is SEPARATE from the session
// log and agent-invisible; the CLI assembles createTelemetry([createJsonlSink(
// process.stdout)]) in run.ts and routes mcp onStatus through the same stream.
describe("M25 --telemetry (JSONL host event stream)", () => {
  // e2e: the real CLI process runs with --telemetry → JSONL lines on stdout.
  it("--telemetry writes JSONL telemetry lines to stdout", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url))
    const res = spawnSync(process.execPath, ["--import", "tsx", entry, "run", "hello", "--telemetry"], {
      cwd: repoRoot,
      encoding: "utf-8",
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('"type":"session/start"') // JSONL 行
    expect(res.stdout).toContain('"type":"turn/start"')
    expect(res.stdout).toContain('"type":"turn/end"')
  }, 30_000)

  // Full event-stream shape through runHeadless with the stdout JSONL sink.
  it("runHeadless telemetry:'jsonl' emits session/turn/provider/tool/token events to stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m25-tele-"))
    writeFileSync(join(dir, "data.txt"), "old line")
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      const result = await runHeadless("read data.txt", {
        workspace: dir,
        approveAll: true,
        telemetry: "jsonl",
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "read", args: { path: "data.txt" } }] },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0)
    } finally {
      spy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
    const events = chunks.join("").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> })
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("session/start")
    expect(types).toContain("turn/start")
    expect(types).toContain("provider/call")
    expect(types).toContain("tool/start")
    expect(types).toContain("tool/end")
    expect(types).toContain("turn/end")
    expect(types).toContain("token/usage")
    expect(types[types.length - 1]).toBe("session/end")
    expect(events[events.length - 1]!.data).toMatchObject({ exitCode: 0 })
  })

  // Default-off: without the flag (or option) no telemetry JSONL is written.
  it("without --telemetry the run emits no telemetry lines (default off)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m25-tele-off-"))
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      const result = await runHeadless("hello", {
        workspace: dir,
        approveAll: true,
        mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(result.exitCode).toBe(0)
    } finally {
      spy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(chunks.join("")).not.toContain('"type":"session/start"')
    expect(chunks.join("")).not.toContain('"type":"turn/start"')
  })

  // mcp onStatus wire: the supervisor's host events flow through the same
  // telemetry stream as mcp/server-status (real stdio subprocess, like M17).
  // mcp onStatus wire: the supervisor's host events flow through the same
  // telemetry stream as mcp/server-status (real stdio subprocess, like M17).
  it("mcp server status flows through the telemetry stream (mcp/server-status)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m25-tele-mcp-"))
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      const result = await runHeadless("hello", {
        workspace: dir,
        approveAll: true,
        telemetry: "jsonl",
        mcp: [{ transport: "stdio", serverName: "tele", command: process.execPath, args: [writeFakeMcpServer()] }],
        mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(result.exitCode).toBe(0)
    } finally {
      spy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
    const status = chunks.join("").split("\n").filter((l) => l.includes("mcp/server-status")).map((l) => JSON.parse(l) as { data: { server: string; state: string } })
    expect(status.length).toBeGreaterThan(0)
    expect(status.some((s) => s.data.server === "tele" && s.data.state === "ready")).toBe(true)
  }, 30_000)
})

// M29: the CLI run path wires the file-backed session query when the session
// store root is known (--session-dir) — the search/lineage tools become
// available out of the box (they mount in the assembly seam).
describe("headless CLI M29 file-backed session query wiring", () => {
  it("main() creates a file-backed query over --session-dir (storeRoot)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m29-wire-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      const before = fileBackedCalls.list.length
      try {
        expect(await main(["node", "i-harness", "run", "hello", "--session-dir", dir])).toBe(0)
      } finally {
        log.mockRestore()
        err.mockRestore()
      }
      const calls = fileBackedCalls.list.slice(before) as { storeRoot: string; dbPath?: string }[][]
      expect(calls).toHaveLength(1)
      // the store root given on the flag, index file left process-private (:memory:)
      expect(calls[0]![0]!.storeRoot).toBe(dir)
      expect(calls[0]![0]!.dbPath).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("--session-backend is removed and fails loud on every subcommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m29-flag-"))
    try {
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        for (const args of [
          ["node", "i-harness", "run", "hello", "--session-dir", dir, "--session-backend", "sqlite"],
          ["node", "i-harness", "web", "--session-backend", "jsonl"],
          ["node", "i-harness", "sdk", "--session-backend", "sqlite"],
          ["node", "i-harness", "acp", "--session-dir", dir, "--session-backend", "sqlite"],
        ]) {
          expect(await main(args)).toBe(1)
        }
        expect(err).toHaveBeenCalled()
      } finally {
        err.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("main() without --session-dir mounts no file-backed query", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const before = fileBackedCalls.list.length
    try {
      expect(await main(["node", "i-harness", "run", "hello"])).toBe(0)
    } finally {
      log.mockRestore()
      err.mockRestore()
    }
    expect(fileBackedCalls.list.length).toBe(before)
  }, 30_000)
})


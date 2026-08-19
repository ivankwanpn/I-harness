import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { existsSync, readdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runHeadless } from "../src/run.ts"
import { main, parseModel } from "../src/index.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createApprovalPolicy } from "@i-harness/guard-approval"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSqliteBackend, closeSqliteBackends } from "@i-harness/session-persistence-sqlite"
import { createSessionQuery, closeSessionQueries } from "@i-harness/session-query"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { CompactionConfig } from "@i-harness/compaction"
import { deriveMessages } from "@i-harness/core-session"

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
  describe("headless CLI M10b session-query tools", () => {
    it("session_search finds previously written session content", async () => {
      const dbPath = join(dir, "query.db") // dir is the per-test temp workspace already used in this file
      const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
      await coordinator.create({ sessionId: "main" })
      await coordinator.append("main", [{ type: "user/message", text: "the purple unicorn fixed the parser" }])
      const sessionQuery = createSessionQuery(dbPath)
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
        closeSqliteBackends()
      }
    })

    it("lineage shows the parent/child structure", async () => {
      const dbPath = join(dir, "query.db")
      const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
      await coordinator.create({ sessionId: "parent" })
      await coordinator.create({ sessionId: "child", parentSession: "parent", delegationDepth: 1, origin: "subagent" })
      const sessionQuery = createSessionQuery(dbPath)
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
        closeSqliteBackends()
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
      // Seed a compacted session over a temp sqlite DB. Seqs are explicit
      // because the sqlite backend stores each event payload verbatim; the
      // summary's shadowedSeqs [0] then hides the old user/message so the
      // resume surface leads with the summary. Without the KNOWN_EVENT_TYPES
      // registration this load path hard-fails (SessionFormatUnsupportedError).
      const dbPath = join(dir, "resume.db")
      const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
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
        closeSqliteBackends()
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

describe("headless CLI SQLite persistence (M5)", () => {
  it("runHeadless with a sqlite coordinator persists to sessions.db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const coordinator = createSessionCoordinator(createSqliteBackend(join(dir, "sessions.db")))
      const { id } = await coordinator.create()
      const result = await runHeadless("hello", {
        workspace: dir,
        approveAll: true,
        sessionId: id,
        coordinator,
      })
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(dir, "sessions.db"))).toBe(true)
    } finally {
      // The sqlite backend holds an open DatabaseSync connection; close it
      // before removing the dir, otherwise rmSync fails on Windows (EPERM).
      closeSqliteBackends()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resume with --session-backend sqlite restores the persisted history into the model request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const coordinator = createSessionCoordinator(createSqliteBackend(join(dir, "sessions.db")))
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
      // The sqlite backend holds an open DatabaseSync connection; close it
      // before removing the dir, otherwise rmSync fails on Windows (EPERM).
      closeSqliteBackends()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("main() with --session-backend sqlite creates a sessions.db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        const code = await main(["node", "i-harness", "run", "hello", "--session-dir", dir, "--session-backend", "sqlite"])
        expect(code).toBe(0)
        expect(existsSync(join(dir, "sessions.db"))).toBe(true)
      } finally {
        log.mockRestore()
      }
    } finally {
      closeSqliteBackends()
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

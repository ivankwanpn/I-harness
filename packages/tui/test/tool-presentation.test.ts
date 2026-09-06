// M49 Task 10 — typed tool presentation: the structured TuiToolEvent
// (args/result/progress), recursive secret redaction, the dedicated
// formatters, and the REAL-fs integration path (a scripted model through the
// REAL embedded service calling the actual fs edit tool — the scrollback
// renders the structured change as an expandable diff block).
//
// Fixture contract (plan "Test Fixture Contract", binding):
//   runRealEditTurn(workspace)   — a real createSessionService assembly with a
//                                  scripted model calling the actual fs edit
//                                  tool in the temp workspace; returns the
//                                  mapped TuiEvent stream of that turn.
//   fixtureWorkspace()           — a fresh temp dir with the fixture file.
//   renderLines(engine)          — every display line's text, joined.
//   redactToolPayload / presentTool — under test (the real units).
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { subscribe } from "@i-harness/core-session"
import { createSessionService } from "@i-harness/session-executor"
import type { TuiEvent, TuiToolEvent } from "../src/contracts.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import { createEventMapState, mapSessionEvent } from "../src/backend/embedded.ts"
import { presentTool, redactToolPayload, SECRET_KEYS } from "../src/tool-presentation/index.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(10)
  }
  throw new Error("waitFor: condition not met within budget")
}

/** Fresh temp workspace with the edit fixture file `a.ts` = "old\n". */
function fixtureWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ih-tui-presentation-"))
  writeFileSync(join(dir, "a.ts"), "old\n", "utf8")
  return dir
}

/** Real assembly + a scripted model calling the real fs edit tool. */
async function runRealEditTurn(workspace: string): Promise<TuiEvent[]> {
  const service = createSessionService({
    workspace,
    approveAll: true,
    modelPolicy: "test-mock",
    mockScript: [
      { role: "assistant", toolCalls: [{ name: "edit", args: { path: "a.ts", old_string: "old", new_string: "new" } }] },
      { role: "assistant", text: "edited the file" },
    ],
  })
  const assembly = await service.assemblyFor("s1")
  const mapped: TuiEvent[] = []
  const state = createEventMapState()
  const unsub = subscribe(assembly.session, (ev) => {
    const m = mapSessionEvent(ev, state)
    if (m !== undefined) mapped.push(m)
  })
  try {
    await service.submit("s1", "edit the file", new AbortController().signal)
    await waitFor(() => mapped.some((e) => e.type === "tool" && e.status === "done"), 12_000)
    await sleep(200)
  } finally {
    unsub()
    await service.close().catch(() => {})
  }
  return mapped
}

/** Every display line's text, joined — the scrollback's whole rendered text. */
function renderLines(engine: ReturnType<typeof createScrollbackEngine>): string {
  return engine.viewport(0, engine.lineCount())
    .map((l) => l.runs.map((r) => r.text).join(""))
    .join("\n")
}

const toolEvent = (p: Omit<Partial<TuiToolEvent>, "callId"> & { callId?: string }): TuiToolEvent => ({
  type: "tool",
  name: "bash",
  kind: "execute",
  status: "done",
  callId: "tc",
  seq: 1,
  ts: 0,
  ...p,
} as TuiToolEvent)

describe("mapSessionEvent — typed tool payload", () => {
  it("preserves tool args and structured results", () => {
    const call = mapSessionEvent({
      type: "tool/call",
      callId: "c1",
      name: "edit",
      args: { path: "a.ts", old_string: "x", new_string: "y" },
      seq: 1,
    }, createEventMapState())
    expect(call).toMatchObject({
      type: "tool",
      callId: "c1",
      args: { path: "a.ts", old_string: "x", new_string: "y" },
    })
  })

  it("preserves the structured result value alongside the presentation string", () => {
    const done = mapSessionEvent({
      type: "tool/result",
      callId: "c1",
      name: "edit",
      output: { ok: true, path: "a.ts", replacements: 1 },
      seq: 2,
    }, createEventMapState())
    expect(done).toMatchObject({
      type: "tool",
      callId: "c1",
      status: "done",
      result: { ok: true, path: "a.ts", replacements: 1 },
    })
    // the presentation string is still the faithful stringified payload
    expect(done && done.type === "tool" && done.output).toContain('"path": "a.ts"')
  })
})

describe("redactToolPayload — recursive secret redaction (spec §7.3)", () => {
  it("knows the exact key set", () => {
    expect(SECRET_KEYS).toEqual(["apiKey", "api_key", "token", "authorization", "password"])
  })

  it("redacts known secret keys recursively", () => {
    expect(redactToolPayload({
      headers: { authorization: "Bearer secret" },
      apiKey: "secret",
      nested: { password: "secret", keep: "ok" },
    })).toEqual({
      headers: { authorization: "***" },
      apiKey: "***",
      nested: { password: "***", keep: "ok" },
    })
  })

  it("recurses through arrays and preserves non-secret structure", () => {
    expect(redactToolPayload({
      items: [
        { name: "a", token: "t1" },
        { password: "t2", api_key: "t3" },
      ],
      ok: true,
    })).toEqual({
      items: [
        { name: "a", token: "***" },
        { password: "***", api_key: "***" },
      ],
      ok: true,
    })
  })

  it("does not mutate the original payload", () => {
    const original = { apiKey: "secret" }
    const out = redactToolPayload(original)
    expect(out).toEqual({ apiKey: "***" })
    expect(original).toEqual({ apiKey: "secret" })
  })
})

describe("presentTool — dedicated formatters", () => {
  it("execute: right/command/args header without touching the structured stdout field", () => {
    const p = presentTool(toolEvent({
      name: "bash", kind: "execute", status: "running",
      args: { command: "echo hi" },
      result: { stdout: "hi\n", apiKey: "SHOULD-NOT-SURFACE" },
    }))
    expect(p.title).toBe("Run echo hi")
    expect(p.body[0]).toMatchObject({ kind: "json" })
    expect(p.raw).toEqual({ args: { command: "echo hi" }, result: { stdout: "hi\n", apiKey: "***" } })
  })

  it("read: the path title + the content text body", () => {
    const p = presentTool(toolEvent({
      name: "read", kind: "read", status: "done",
      args: { path: "src/a.ts" },
      result: { content: "line1\nline2" },
      output: "line1\nline2",
    }))
    expect(p.title).toBe("Read src/a.ts")
    expect(p.body[0]).toMatchObject({ kind: "text", value: "line1\nline2" })
  })

  it("edit/write/apply_patch: the structured change becomes an expandable diff block with literal delta", () => {
    const change = { path: "a.ts", added: 1, deleted: 1, hunks: [], truncated: false }
    const p = presentTool(toolEvent({
      name: "edit", kind: "edit", status: "done",
      args: { path: "a.ts" },
      result: { ok: true, path: "a.ts", change },
      output: "-old\n+new",
    }))
    expect(p.title).toBe("Edit a.ts")
    expect(p.summary).toBe("(+1/-1)")
    expect(p.body[0]).toMatchObject({ kind: "diff", value: change })
  })

  it("search: pattern header + matches summary never duplicated from the structured payload", () => {
    const p = presentTool(toolEvent({
      name: "grep", kind: "search", status: "done",
      args: { pattern: "TODO", path: "src" },
      result: { matches: 3 },
      output: "a.ts:1: TODO",
    }))
    expect(p.title).toBe("Search TODO")
    expect(p.summary).toBe("(3 matches)")
  })

  it("web fetch/search: url/query headers", () => {
    expect(presentTool(toolEvent({ name: "webfetch", kind: "webfetch", args: { url: "https://x/1" }, result: { body: "…" } })).title).toBe("Fetch https://x/1")
    expect(presentTool(toolEvent({ name: "websearch", kind: "websearch", args: { query: "grok tui" }, result: { results: [] } })).title).toBe("Search web for grok tui")
  })

  it("mcp/skill/subagent/todo/generic: one title each — fields from the structured payload, never regex", () => {
    expect(presentTool(toolEvent({ name: "mcp_brave_search", kind: "mcp-tool", args: { query: "x" }, result: { results: [] } })).title).toBe("Call mcp_brave_search")
    expect(presentTool(toolEvent({ name: "skill", kind: "skill", args: { skill: "write-tests" }, result: { ok: true } })).title).toBe("Invoke write-tests")
    expect(presentTool(toolEvent({ name: "task", kind: "subagent", status: "running", args: { subject: "explore" } })).title).toBe("Started explore")
    expect(presentTool(toolEvent({ name: "todo_update", kind: "todo", args: { items: [{ content: "a", status: "pending" }] }, result: { ok: true } })).title).toBe("Update todo")
    expect(presentTool(toolEvent({ name: "weird_tool", kind: "other", args: { cmd: "x" } })).title).toBe("Call weird_tool")
  })

  it("never surfaces a secret value through ANY presentation field", () => {
    const p = presentTool(toolEvent({
      name: "bash", kind: "execute",
      args: { command: "curl -s https://api/x", apiKey: "top-secret-value" },
      result: { stdout: "ok", token: "second-secret" },
      output: "ok",
    }))
    // the JSON body (from the redacted args) + the raw composite are the only
    // payload-derived fields — both are redacted (the headline readable
    // command is the only args field that renders by design).
    const dump = JSON.stringify({ ...p, body: p.body.map((b) => b.value) })
    expect(dump).not.toContain("top-secret-value")
    expect(dump).not.toContain("second-secret")
    expect(p.title).toBe("Run curl -s https://api/x")
    // the redacted raw really carries the placeholder, the value never.
    const raw = JSON.stringify(p.raw)
    expect(raw).toContain('"apiKey":"***"')
    expect(raw).not.toContain("top-secret-value")
  })
})

describe("typed tool presentation through the real scrollback (red-green step 2)", () => {
  it("formats a real edit result as an expandable diff block", async () => {
    const events = await runRealEditTurn(fixtureWorkspace())
    const engine = createScrollbackEngine({ width: 100 })
    events.forEach((event) => engine.append(event))
    const text = renderLines(engine)
    expect(text).toContain("a.ts (+1/-1)")
    expect(text).toContain("-old")
    expect(text).toContain("+new")
  })

  it("typed headers come from the structured args (never a bare tool name)", () => {
    const engine = createScrollbackEngine({ width: 80 })
    engine.append(toolEvent({
      callId: "b1", name: "bash", kind: "execute", status: "running",
      args: { command: "sed s/x/y/ < a.ts" },
    }))
    expect(renderLines(engine)).toContain("Run sed s/x/y/ < a.ts")
  })

  it("a running tool followed by its done update keeps the typed header and replaces the output", () => {
    const engine = createScrollbackEngine({ width: 80 })
    engine.append(toolEvent({
      callId: "b1", name: "bash", kind: "execute", status: "running", seq: 1,
      args: { command: "echo hi" }, output: "o1\n",
    }))
    engine.append(toolEvent({
      callId: "b1", name: "bash", kind: "execute", status: "done", seq: 2,
      args: { command: "echo hi" }, result: { stdout: "done" }, output: "done",
    }))
    expect(renderLines(engine)).toContain("Run echo hi")
    expect(renderLines(engine)).toContain("done")
    expect(renderLines(engine)).not.toContain("o1")
  })

  it("redaction at the UI boundary: a secret value under a secret key is never rendered", () => {
    const engine = createScrollbackEngine({ width: 80 })
    // args.apiKey holds the secret; the typed header only reads the REDACTED
    // args (the JSON args body never reaches the scrollback at all).
    engine.append(toolEvent({
      callId: "s1", name: "curl", kind: "execute", status: "done",
      args: { command: "curl -s https://api/x", apiKey: "sk-not-here-1111" },
      result: { stdout: "ok", token: "tkn-not-here-2222" },
      output: "ok",
    }))
    const engineText = renderLines(engine)
    expect(engineText).toContain("Run curl -s https://api/x")
    expect(engineText).not.toContain("sk-not-here-1111")
    expect(engineText).not.toContain("tkn-not-here-2222")
    // the block viewer presentation is redacted identically
    const p = presentTool(toolEvent({
      callId: "s1", name: "curl", kind: "execute", status: "done",
      args: { command: "curl -s https://api/x", apiKey: "sk-not-here-1111" },
      result: { stdout: "ok", token: "tkn-not-here-2222" },
      output: "ok",
    }))
    expect(JSON.stringify(p)).not.toContain("sk-not-here-1111")
    expect(JSON.stringify(p)).not.toContain("tkn-not-here-2222")
  })
})

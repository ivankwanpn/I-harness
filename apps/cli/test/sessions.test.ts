// M61: `i-harness sessions` — the CLI face of the durable store. Pins the
// listing (a live store with blank rows, a corrupt file, a missing dir), the
// transcript renderer (context snapshots stay out of it), and the argument
// parsing (`--session-dir` / `--last` / `--json`).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import {
  formatAge,
  listStoredSessions,
  parseSessionsArgs,
  renderSessionTable,
  renderTranscript,
  runSessionsCommand,
} from "../src/sessions.ts"

const roots: string[] = []
function storeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ih-sessions-"))
  roots.push(dir)
  return dir
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** Seed one session with `turns` user turns (+ a tool call in the first). */
async function seed(root: string, id: string, turns: number, title?: string): Promise<void> {
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: false } })
  try {
    await coordinator.create({ sessionId: id, ...(title !== undefined ? { title } : {}) })
    const events = []
    for (let i = 0; i < turns; i++) {
      events.push({ type: "turn/start" as const }, { type: "user/message" as const, text: `prompt ${i}` })
      if (i === 0) {
        events.push({ type: "tool/call" as const, callId: "c1", name: "bash", args: { command: "pwd" } })
        events.push({ type: "tool/result" as const, callId: "c1", name: "bash", output: { stdout: "ok", exitCode: 0 } })
      }
      events.push({ type: "assistant/message" as const, text: `answer ${i}` }, { type: "turn/end" as const })
    }
    await coordinator.append(id, events)
    await coordinator.flush(id)
  } finally {
    await coordinator.close().catch(() => {})
  }
}

describe("parseSessionsArgs", () => {
  it("defaults to list; show takes the id; flags parse (dir/json/last)", () => {
    expect(parseSessionsArgs(["sessions"])).toEqual({ subcommand: "list", options: {} })
    expect(parseSessionsArgs(["sessions", "list", "--json"])).toEqual({ subcommand: "list", options: { json: true } })
    expect(parseSessionsArgs(["sessions", "show", "s-1", "--last", "5"])).toEqual({
      subcommand: "show", id: "s-1", options: { last: 5 },
    })
    expect(parseSessionsArgs(["sessions", "show", "s-1", "--session-dir", "C:\\x"]).options.sessionDir).toBe("C:\\x")
    expect(parseSessionsArgs(["sessions", "help"]).subcommand).toBe("help")
  })

  it("ignores a non-positive --last (falls back to the default)", () => {
    expect(parseSessionsArgs(["sessions", "show", "s", "--last", "0"]).options.last).toBeUndefined()
    expect(parseSessionsArgs(["sessions", "show", "s", "--last", "abc"]).options.last).toBeUndefined()
  })
})

describe("listStoredSessions", () => {
  it("lists every stored session newest-first with its turn count", async () => {
    const root = storeRoot()
    await seed(root, "sess-old", 1, "the old one")
    await seed(root, "sess-new", 2)
    const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: false } })
    try {
      const rows = await listStoredSessions(coordinator, root)
      expect(rows.map((r) => r.id).sort()).toEqual(["sess-new", "sess-old"])
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.get("sess-old")).toMatchObject({ title: "the old one", turnCount: 1 })
      expect(byId.get("sess-new")).toMatchObject({ turnCount: 2 })
      expect(byId.get("sess-new")?.updatedAt).toBeTypeOf("number")
      // newest first
      expect(rows[0]!.updatedAt!).toBeGreaterThanOrEqual(rows[1]!.updatedAt!)
    } finally {
      await coordinator.close().catch(() => {})
    }
  })

  it("an unreadable file is a labelled row, never a failed listing", async () => {
    const root = storeRoot()
    await seed(root, "good", 1)
    writeFileSync(join(root, "broken.jsonl"), "{not json}\n", "utf8")
    const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: false } })
    try {
      const rows = await listStoredSessions(coordinator, root)
      expect(rows.map((r) => r.id)).toContain("good")
      const broken = rows.find((r) => r.id === "broken")
      expect(broken?.problem).toBeTypeOf("string")
      expect(renderSessionTable(rows)).toContain("good")
    } finally {
      await coordinator.close().catch(() => {})
    }
  })

  it("an empty (never-used) store lists nothing — and says so", async () => {
    const root = storeRoot()
    mkdirSync(root, { recursive: true })
    const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: false } })
    try {
      expect(await listStoredSessions(coordinator, root)).toEqual([])
    } finally {
      await coordinator.close().catch(() => {})
    }
    expect(renderSessionTable([])).toBe("no sessions in this store")
  })
})

describe("renderSessionTable", () => {
  it("aligns columns and renders the age buckets", () => {
    const now = 1_000_000_000
    const table = renderSessionTable([
      { id: "s-1", title: "first", turnCount: 3, updatedAt: now - 5_000 },
      { id: "s-2-long-id", turnCount: 0, updatedAt: now - 3 * 3600_000 },
    ], now)
    const lines = table.split("\n")
    expect(lines[0]).toMatch(/^ID\s+TITLE\s+TURNS\s+UPDATED$/)
    expect(lines[1]).toContain("s-1")
    expect(lines[1]).toContain("just now")
    expect(lines[2]).toContain("3h")
    expect(lines[2]).toContain("(untitled)")
    // a missing updatedAt is honest, not zero
    expect(renderSessionTable([{ id: "x" }], now)).toContain("—")
  })

  it("formatAge buckets: just now / m / h / d", () => {
    const now = 100 * 3600_000
    expect(formatAge(now - 1_000, now)).toBe("just now")
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m")
    expect(formatAge(now - 3 * 3600_000, now)).toBe("3h")
    expect(formatAge(now - 50 * 3600_000, now)).toBe("2d")
    expect(formatAge(undefined, now)).toBe("—")
  })
})

describe("renderTranscript", () => {
  it("prints turns, prompts, assistant text and one-line tool calls — context snapshots stay out", () => {
    const session = createSession()
    append(session, { type: "turn/start" })
    append(session, { type: "user/message", text: "do it" })
    append(session, { type: "user/message", text: "Current runtime context: none. Earlier…", source: { kind: "plugin", plugin: "i-harness/runtime-context" }, internal: true })
    append(session, { type: "tool/call", callId: "c1", name: "bash", args: { command: "pwd" } })
    append(session, { type: "tool/result", callId: "c1", name: "bash", output: { stdout: "ok" } })
    append(session, { type: "assistant/message", text: "done" })
    const text = renderTranscript(session, 20)
    expect(text).toContain("─── turn")
    expect(text).toContain("❯ do it")
    expect(text).not.toContain("Current runtime context")
    expect(text).toContain('◆ bash {"command":"pwd"}')
    expect(text).toContain("done")
  })

  it("--last keeps the TAIL (with an honest elision marker)", () => {
    const session = createSession()
    for (let i = 0; i < 10; i++) append(session, { type: "assistant/message", text: `line ${i}` })
    const text = renderTranscript(session, 3)
    expect(text).toContain("line 9")
    expect(text).not.toContain("line 0")
    expect(text).toContain("earlier line(s)")
  })
})

describe("runSessionsCommand", () => {
  it("list --json emits the rows + the root it read", async () => {
    const root = storeRoot()
    await seed(root, "s-1", 1, "titled")
    const logs: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")) })
    try {
      await expect(runSessionsCommand(["sessions", "list", "--session-dir", root, "--json"])).resolves.toBe(0)
    } finally {
      spy.mockRestore()
    }
    const parsed = JSON.parse(logs.join("\n"))
    expect(parsed.storeRoot).toBe(root)
    expect(parsed.sessions[0]).toMatchObject({ id: "s-1", title: "titled", turnCount: 1 })
  })

  it("an unknown id exits 1 with a legible message (never a stack trace)", async () => {
    const root = storeRoot()
    mkdirSync(root, { recursive: true })
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    let code: number
    try {
      code = await runSessionsCommand(["sessions", "show", "nope", "--session-dir", root])
    } finally {
      spy.mockRestore()
    }
    expect(code).toBe(1)
    expect(errors.join("\n")).toContain("session not found: nope")
  })

  it("a corrupt store still lists the readable rows (exit 0)", async () => {
    const root = storeRoot()
    await seed(root, "good", 1)
    appendFileSync(join(root, "broken.jsonl"), "{oops}\n", "utf8")
    const logs: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")) })
    let code: number
    try {
      code = await runSessionsCommand(["sessions", "list", "--session-dir", root])
    } finally {
      spy.mockRestore()
    }
    expect(code).toBe(0)
    expect(logs.join("\n")).toContain("good")
  })
})

// e2e/team.e2e.ts — M25 §2.1: the team surface + the REAL spawned-CLI process layer.
//
// Mock-injection ruling (M25-P2, resolution option b): the spawned CLI has NO
// mock-script seam — HeadlessOptions.mockScript is host-only (index.ts parses
// no flag for it), so a spawned run always replays run.ts:164's default
// text-only cassette `[{ role: "assistant", text: "ok" }]`, which emits NO
// tool calls. The e2e layer therefore splits:
//   - SPAWNED real `node --import <tsx> apps/cli/src/index.ts run ...`
//     processes cover the process level: entry guard, argv parsing,
//     default-mock completion (no API key, no flags), --session-dir
//     durability, --resume across two real processes, --telemetry JSONL.
//   - Tool-driving tests call the REAL runHeadless (the exact function
//     main() invokes) with a mockScript cassette — real tool registry, real
//     team mount, real coordinator/session persistence on disk; only the
//     model is a cassette (the spec's own mock-model mandate, zero API key).
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runHeadless } from "../apps/cli/src/run.ts"
import { createSessionCoordinator } from "../packages/session-persistence/src/index.ts"
import { createJsonlBackend } from "../packages/session-persistence-jsonl/src/index.ts"
import { makeWorkspace, removeWorkspace, runCli } from "./helpers.ts"

describe("e2e team: real spawned CLI processes (default mock — zero special handling)", () => {
  it("spawned CLI completes a real run with the default mock (exit 0, stdout ok)", () => {
    const ws = makeWorkspace("i-harness-e2e-team-")
    try {
      // workspace = ws (the CLI treats cwd as the workspace); no flags beyond
      // --yes: the model is run.ts:164's default mock — no API key needed.
      const res = runCli(["run", "smoke the harness", "--yes"], ws)
      expect(res.status, `stderr: ${res.stderr}`).toBe(0)
      expect(res.stdout.trim()).toBe("ok")
    } finally {
      removeWorkspace(ws)
    }
  })

  it("--session-dir persists a durable session; --resume continues it in a second real process", () => {
    const ws = makeWorkspace("i-harness-e2e-team-")
    try {
      const sessionDir = join(ws, "sessions")
      const first = runCli(["run", "persist this task", "--yes", "--session-dir", sessionDir], ws)
      expect(first.status, `stderr: ${first.stderr}`).toBe(0)
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
      expect(files.length).toBe(1)
      const log = readFileSync(join(sessionDir, files[0]!), "utf8")
      expect(log).toContain("persist this task")

      // A SECOND real process resumes the first one's durable log. The M23
      // ownership lease is adopted per run and released when the first
      // process exits, so the sequential resume must not conflict.
      const sessionId = files[0]!.replace(/\.jsonl$/, "")
      const second = runCli(["run", "continue here", "--yes", "--session-dir", sessionDir, "--resume", sessionId], ws)
      expect(second.status, `stderr: ${second.stderr}`).toBe(0)
      expect(second.stdout.trim()).toBe("ok")
    } finally {
      removeWorkspace(ws)
    }
  })

  it("--telemetry streams the host event flow as stdout JSONL (session/start … session/end)", () => {
    const ws = makeWorkspace("i-harness-e2e-team-")
    try {
      const res = runCli(["run", "emit telemetry", "--yes", "--telemetry"], ws)
      expect(res.status, `stderr: ${res.stderr}`).toBe(0)
      // stdout mixes the final text ("ok") with one JSON object per telemetry
      // event — parse line-by-line and keep only the JSON lines.
      const events = res.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as { type?: unknown; data?: { task?: unknown; exitCode?: unknown } }
          } catch {
            return undefined
          }
        })
        .filter((e): e is { type: string; data: { task?: unknown; exitCode?: unknown } } => e !== undefined && typeof e.type === "string")
      const types = new Set(events.map((e) => e.type))
      expect(types.has("session/start")).toBe(true)
      expect(types.has("turn/start")).toBe(true)
      expect(types.has("session/end")).toBe(true)
      const start = events.find((e) => e.type === "session/start")
      expect(start?.data.task).toBe("emit telemetry")
      const end = events.find((e) => e.type === "session/end")
      expect(end?.data.exitCode).toBe(0)
    } finally {
      removeWorkspace(ws)
    }
  })
})

describe("e2e team: tool-driving through the real runHeadless (mockScript cassette)", () => {
  it("spawn_teammate completes a real subagent with a durable child session", async () => {
    const dir = makeWorkspace("i-harness-e2e-teamrun-")
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
          // consumed by the spawned teammate's own (shared-mock) turn
          { role: "assistant", text: "child done" },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode, result.error).toBe(0)
      expect(result.finalText).toBe("done")
      const spawn = result.session?.events.find((e) => e.type === "tool/result" && e.name === "spawn_teammate")
      expect(spawn).toBeDefined()
      expect(JSON.stringify((spawn as { output: unknown }).output)).toContain("helper")
      // The teammate is a REAL durable child session file on disk (the M19
      // realSpawnChild bridge → subagent spawnChild → coordinator lineage).
      const childIds = readdirSync(dir).filter((f) => f.startsWith("child-") && f.endsWith(".jsonl"))
      expect(childIds.length).toBe(1)
      // Drain the trailing fire-and-forget subagent-state save (triggered by
      // the team unmount) before rmSync — same discipline as cli.test.ts M19.
      await coordinator.close()
    } finally {
      removeWorkspace(dir)
    }
  }, 60_000)
})

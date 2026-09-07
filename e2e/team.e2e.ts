// e2e/team.e2e.ts — M25 §2.1: the team surface + the REAL spawned-CLI process layer.
//
// Mock-injection ruling (M25-P2, resolution option b) + M49 supersede: the
// spawned CLI has NO mock-script seam — HeadlessOptions.mockScript is
// host-only (index.ts parses no flag for it). M49 turned the CLI run default
// to modelPolicy "required" (the pre-M49 default text-only cassette is GONE;
// see apps/cli/src/run.ts:214-219 — `mockScript` is an explicit fixture, the
// absence of a model is the honest gate). The e2e layer splits:
//   - SPAWNED real `node --import <tsx> apps/cli/src/index.ts run ...`
//     processes cover the process level: entry guard, argv parsing and the
//     REQUIRED-MODEL gate (no configured provider → exit 1 + the gate
//     message, never a silent mock).
//   - The real flows (durability + resume across two runs, --telemetry
//     JSONL, tool driving) call the REAL runHeadless (the exact function
//     main() invokes) with an explicit mockScript cassette — real tool
//     registry, real team mount, real coordinator/session persistence on
//     disk; only the model is a cassette (the M49 mock-model mandate: tests
//     may explicitly inject a fixture, production never does).
import { describe, expect, it, vi } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runHeadless } from "../apps/cli/src/run.ts"
import { createSessionCoordinator } from "../packages/session-persistence/src/index.ts"
import { createJsonlBackend } from "../packages/session-persistence-jsonl/src/index.ts"
import { makeWorkspace, removeWorkspace, runCli } from "./helpers.ts"

describe("e2e team: real spawned CLI processes (M49 required-model policy)", () => {
  it("spawned CLI with no configured model exits 1 with the honest gate (no silent mock)", () => {
    const ws = makeWorkspace("i-harness-e2e-team-")
    try {
      // M49: the CLI run default is modelPolicy "required" — the pre-M49
      // default-mock completion is GONE; an unconfigured run is the honest
      // gate (the entry guard + argv parsing still prove the process layer).
      const res = runCli(["run", "smoke the harness", "--yes"], ws)
      expect(res.status, `stderr: ${res.stderr}`).toBe(1)
      expect(res.stderr).toContain("No model configured")
    } finally {
      removeWorkspace(ws)
    }
  })

  it("--session-dir persists a durable session; --resume continues in a second real run (explicit mockScript cassette)", async () => {
    const ws = makeWorkspace("i-harness-e2e-team-")
    try {
      const sessionDir = join(ws, "sessions")
      const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
      const { id } = await coordinator.create()
      // runHeadless is exactly the function main() invokes; the M49 mock
      // mandate: an explicit cassette is the only mock path.
      const first = await runHeadless("persist this task", {
        workspace: ws,
        sessionId: id,
        coordinator,
        approveAll: true,
        mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(first.exitCode, first.error).toBe(0)
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
      expect(files.length).toBe(1)
      const log = readFileSync(join(sessionDir, files[0]!), "utf8")
      expect(log).toContain("persist this task")
      await coordinator.close()

      // A SECOND run resumes the first one's durable log through a fresh
      // coordinator — the sequential resume must not conflict (the M23
      // ownership lease is taken per run and released when it exits).
      const sessionId = files[0]!.replace(/\.jsonl$/, "")
      const secondCoordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
      const second = await runHeadless("continue here", {
        workspace: ws,
        resumeSessionId: sessionId,
        coordinator: secondCoordinator,
        approveAll: true,
        mockScript: [{ role: "assistant", text: "ok" }],
      })
      expect(second.exitCode, second.error).toBe(0)
      expect(second.finalText).toBe("ok")
      await secondCoordinator.close()
    } finally {
      removeWorkspace(ws)
    }
  })

  it("--telemetry streams the host event flow as JSONL (session/start … session/end)", async () => {
    const ws = makeWorkspace("i-harness-e2e-team-")
    try {
      const writes: string[] = []
      const spy = vi.spyOn(process.stdout, "write")
      spy.mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk))
        return true
      })
      const result: Awaited<ReturnType<typeof runHeadless>> = await (async () => {
        try {
          return await runHeadless("emit telemetry", {
            workspace: ws,
            approveAll: true,
            telemetry: "jsonl",
            mockScript: [{ role: "assistant", text: "ok" }],
          })
        } finally {
          spy.mockRestore()
        }
      })()
      expect(result.exitCode, result.error).toBe(0)
      // one JSON object per telemetry event on the host stream.
      const events = writes
        .join("")
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

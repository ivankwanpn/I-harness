import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveShell } from "@i-harness/shell"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import { createSessionService, type SessionService } from "../src/service.ts"
import { rmWorkspaceSync } from "./helpers.ts"

// ── the service-created assembly is where the sdk/acp hosts get their bound ──
// `createOutputSpillGuard` is mounted on `if (opts.outputSpill)` and the option
// is ABSENT by default (block ③'s ruling: the assembly keeps "absent = not
// mounted"; the CALL SITES opt in). runHeadless opts in (`outputSpill: opts.
// outputSpill ?? {}`); these two hosts build their assemblies through
// `createSessionService`, which is a THIRD call site — the one block ③'s B1
// recorded as unbounded. The option has to survive the service's own option
// plumbing into BOTH `createSessionAssembly` calls (the binding path and the
// legacy path); these tests drive the binding path the CLI app configures.
//
// The drive is BEHAVIOR, not a read of the options object: a real turn goes
// through the service's lane into a real assembly, runs a real shell tool whose
// output is past the cap, and the DURABLE record is read back — the guard
// rewrites `output` (the log), which is exactly what a mount does here.
const CAP = 2_000
const BIG_BYTES = 200_000

function script(shell: string): MockStep[] {
  return [
    {
      role: "assistant",
      toolCalls: [{ name: shell, args: { command: `node -e "process.stdout.write('y'.repeat(${BIG_BYTES}))"` } }],
    },
    { role: "assistant", text: "done" },
  ]
}

/** A service wired the way the sdk/acp commands wire theirs (modelBindingFor),
 *  with `outputSpill` supplied or omitted per test. */
function serviceWith(workspace: string, outputSpill?: { maxOutputBytes: number; spillRoot: string }): SessionService {
  const shell = resolveShell().name
  return createSessionService({
    workspace,
    modelPolicy: "required",
    approveAll: true,
    ...(outputSpill !== undefined ? { outputSpill } : {}),
    modelBindingFor: async () => ({
      status: "ready",
      binding: { model: createMockClient(script(shell)), providerId: "mock", modelId: "mock-model", label: "mock:mock-model" },
    }),
  })
}

function toolResults(service: SessionService, sessionId: string): Array<{ output: { stdout?: string; output?: string; outputPaths?: string[]; spill?: unknown } }> {
  const session = service.liveSession(sessionId)
  expect(session).toBeDefined()
  return session!.events.filter((event) => event.type === "tool/result") as never
}

describe("createSessionService — outputSpill reaches the assembly it builds", () => {
  it("a service created with outputSpill mounts the guard: the over-cap durable result is the bound envelope", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "m5-service-spill-ws-"))
    const spillRoot = join(tmpdir(), `m5-service-spill-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const service = serviceWith(workspace, { maxOutputBytes: CAP, spillRoot })
    try {
      await service.submit("s1", "run the command", new AbortController().signal)
      const [result] = toolResults(service, "s1")
      expect(result).toBeDefined()
      // The guard's object branch: `{ output, outputPaths, spill }`.
      expect(result!.output.spill).toBeDefined()
      expect(result!.output.outputPaths?.[0]).toContain(spillRoot)
      expect(result!.output.output).toContain("Full result stored at:")
      // ... and the replacement is inside the cap, in the guard's own measure.
      expect(Buffer.byteLength(JSON.stringify(result!.output), "utf-8")).toBeLessThanOrEqual(CAP)
      // The mount is also observable as the guard's own construction: its store
      // root is created when the guard is built (createSpillStore mkdirs it).
      expect(existsSync(spillRoot)).toBe(true)
    } finally {
      await service.close()
      rmWorkspaceSync(workspace)
      rmSync(spillRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it("the CONVERSE — a service created without it mounts nothing: the same result is durable whole", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "m5-service-spill-off-ws-"))
    const service = serviceWith(workspace)
    try {
      await service.submit("s1", "run the command", new AbortController().signal)
      const [result] = toolResults(service, "s1")
      expect(result).toBeDefined()
      // "Absent = not mounted": no envelope, no spill path, and the payload is
      // past the cap the other test's guard bounds it to.
      expect(result!.output.spill).toBeUndefined()
      expect(result!.output.outputPaths).toBeUndefined()
      expect(result!.output.output).toBeUndefined()
      const raw = Buffer.byteLength(JSON.stringify(result!.output), "utf-8")
      expect(raw).toBeGreaterThan(CAP)
    } finally {
      await service.close()
      rmWorkspaceSync(workspace)
    }
  }, 60_000)
})

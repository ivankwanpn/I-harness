import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMockClient } from "@i-harness/llm-mock"
import { createSession, append } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"

/**
 * PER-CALL sandbox resolution.
 *
 * The defect: the assembly resolved the sandbox policy ONCE at construction and
 * the fs `writeGuard` closed over that value, so a `sandbox/mode` event appended
 * mid-session was invisible — the session had to be torn down and rebuilt for a
 * mode change to apply. The escalation ladder this design is heading for IS a
 * mid-session mode change, so nothing downstream of it could work.
 *
 * WHY THIS IS DRIVEN END-TO-END, through a real turn and the real `write` tool,
 * rather than by reaching into the assembly for its guard: exposing the guard
 * would be test-only surface living in production code, and it would assert on a
 * synthetic call instead of the actual tool boundary the model sees. Running the
 * turn is the same shape `sandbox-fs-confinement.test.ts` already uses, and it
 * proves the property that matters: the NEXT tool call obeys the NEW mode.
 *
 * `approveAll: true` is the dangerous combination on purpose (the same one that
 * file documents): approval asks "may I?", the sandbox answers "no". With
 * approval auto-granted, the sandbox policy is the only thing that can refuse
 * these writes — so a passing test cannot be the approval layer talking.
 */

/** A script of one write-tool turn per target: call, then a plain completion. */
function modelWritingTargets(targets: readonly string[]) {
  return createMockClient(
    targets.flatMap((target) => [
      { role: "assistant" as const, toolCalls: [{ name: "write", args: { path: target, text: "escaped" } }] },
      { role: "assistant" as const, text: "done" },
    ]),
  )
}

/** One real turn on the assembly's session, drained to completion. */
async function runTurn(assembly: SessionAssembly): Promise<void> {
  const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
  executor.submit({ tier: "send", text: "go" })
  await executor.drain()
}

describe("sandbox policy is resolved per call", () => {
  it("a sandbox/mode event appended mid-session takes effect on the NEXT tool call", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-percall-"))
    const workspace = join(base, "ws")
    const outside = join(base, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const before = join(outside, "before.txt")
    const after = join(outside, "after.txt")
    const session = createSession()
    append(session, { type: "user/message", text: "write it" })
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: modelWritingTargets([before, after]),
      // The dangerous combination: approval is auto-granted, so the ONLY thing
      // that can refuse a write is the sandbox policy.
      approveAll: true,
      // Start permissive; the tightening event is appended AFTER construction, so
      // it can only be seen by a resolver that reads the session per call.
      sandbox: "danger-full-access",
    })
    try {
      // Turn 1 — constructed permissive, so the write outside the workspace lands.
      // This is the control: without it the test could pass by refusing everything.
      await runTurn(assembly)
      expect(readFileSync(before, "utf8")).toBe("escaped")

      // The mid-session mode change. No reassembly, no new assembly.
      append(session, { type: "sandbox/mode", mode: "read-only" })

      // Turn 2 — the NEXT tool call must obey the new mode.
      await runTurn(assembly)
      expect(existsSync(after)).toBe(false)
      // Model-visible as a classified failure, not a thrown turn-killer.
      const denials = session.events.filter(
        (e) => e.type === "tool/result" && JSON.stringify(e).includes("FS_SANDBOX_DENIED"),
      )
      expect(denials.length).toBe(1)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("MEASURE: effectiveSandboxMode scan cost", async () => {
    const { effectiveSandboxMode } = await import("@i-harness/sandbox-policy")
    const session = createSession()
    for (let i = 0; i < 20_000; i += 1) append(session, { type: "user/message", text: "x" })
    const t0 = performance.now()
    for (let i = 0; i < 1_000; i += 1) effectiveSandboxMode(session.events)
    const perCall = (performance.now() - t0) / 1_000
    console.log(`scan over ${session.events.length} events: ${perCall.toFixed(3)} ms/call`)
    expect(perCall).toBeLessThan(5)
  })
})

/**
 * RESTORED HISTORY MUST NOT DECIDE THE MODE.
 *
 * Per-call resolution made the session's `sandbox/mode` events authoritative, and a
 * resumed session carries events restored from persistence. A session once
 * escalated to `danger-full-access` and later resumed under `--sandbox read-only`
 * would then enforce the ESCALATED mode — a privilege escalation on resume,
 * defeated by the very rule the surrounding code states in prose ("a resumed
 * session's fully restored history must not silently override the requested mode").
 *
 * The rule the code implements: only events appended AFTER construction are this
 * session's decisions. This test pins it. The reviewer's finding was that the
 * opposite behavior was live and untested, with Task 3's escalation ladder as the
 * producer that would make it reachable in production.
 */
describe("restored history does not decide the sandbox mode", () => {
  it("a persisted sandbox/mode event does NOT override the mode this run requested", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-restored-"))
    const workspace = join(base, "ws")
    const outside = join(base, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const target = join(outside, "escalated.txt")
    const session = createSession()
    append(session, { type: "user/message", text: "write it" })
    // RESTORED HISTORY: an escalation recorded by an earlier run, already present
    // when this assembly is constructed.
    append(session, { type: "sandbox/mode", mode: "danger-full-access" })
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: createMockClient([
        { role: "assistant", toolCalls: [{ name: "write", args: { path: target, text: "escalated" } }] },
        { role: "assistant", text: "done" },
      ]),
      approveAll: true,
      // THIS run asks for read-only. The restored escalation must not win.
      sandbox: "read-only",
    })
    try {
      const executor = createSessionExecutor({ session, agent: assembly.agent, inbox: assembly.inbox })
      executor.submit({ tier: "send", text: "go" })
      await executor.drain()
      expect(existsSync(target)).toBe(false)
      expect(session.events.some((e) => JSON.stringify(e).includes("FS_SANDBOX_DENIED"))).toBe(true)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })
})

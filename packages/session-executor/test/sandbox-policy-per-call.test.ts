import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMockClient } from "@i-harness/llm-mock"
import type { LLMRequest } from "@i-harness/llm-seam"
import { createSession, append } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import type { SandboxDenial } from "@i-harness/sandbox"
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
      // Model-visible as a classified failure, not a thrown turn-killer — and the
      // denial must name the mode that was ACTUALLY in force. Asserting only
      // `FS_SANDBOX_DENIED` would pass for a denial carrying the mount-time mode,
      // which is the one field this test exists to pin.
      const denials = session.events.filter(
        (e) => e.type === "tool/result" && JSON.stringify(e).includes("FS_SANDBOX_DENIED"),
      )
      expect(denials.length).toBe(1)
      const output = (denials[0] as { output?: { error?: string } }).output
      const denial = JSON.parse(output!.error!) as SandboxDenial
      expect(denial.code).toBe("SANDBOX_DENIED")
      expect(denial.surface).toBe("fs")
      expect(denial.mode).toBe("read-only")
      expect(denial.reason.replaceAll("\\", "/")).toContain(after.replaceAll("\\", "/"))
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("the system prompt states the mode in force on the NEXT request", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-prompt-now-"))
    const workspace = join(base, "ws")
    const outside = join(base, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const first = join(outside, "first.txt")
    const second = join(outside, "second.txt")
    const session = createSession()
    append(session, { type: "user/message", text: "write it" })
    // Capture what the provider actually RECEIVES. Reading a prompt value off the
    // assembly would assert on an internal; the request is the boundary the model
    // sees, and it is also where "the fragment says Current" can be falsified.
    const prompts: string[] = []
    const inner = modelWritingTargets([first, second])
    const model = {
      stream: (req: LLMRequest) => {
        prompts.push(req.systemPrompt)
        return inner.stream(req)
      },
    }
    const assembly = await createSessionAssembly({
      workspace, session, model,
      approveAll: true,
      sandbox: "danger-full-access",
    })
    try {
      // Turn 1 — the mode the assembly was constructed with.
      await runTurn(assembly)
      const turnOne = prompts.length
      expect(turnOne).toBeGreaterThan(0)
      expect(prompts.at(-1)).toContain("danger-full-access")
      // The mode did not change across the turn's steps, so the fragment is
      // memoised and every request carries a byte-identical string. A prompt that
      // churned per step would defeat provider-side prefix caching.
      expect(new Set(prompts.slice(0, turnOne)).size).toBe(1)

      // The mode changes; the NEXT request must say so.
      append(session, { type: "sandbox/mode", mode: "read-only" })
      await runTurn(assembly)
      // Guard against a vacuous assertion: the turn below must have issued a NEW
      // request, or `at(-1)` would still be turn 1's prompt and pass for free.
      expect(prompts.length).toBeGreaterThan(turnOne)
      expect(prompts.at(-1)).toContain("read-only")
      expect(prompts.at(-1)).not.toContain("danger-full-access")

      // The prompt is not the only thing that moved: the guard enforced the mode
      // the prompt just described.
      expect(readFileSync(first, "utf8")).toBe("escaped")
      expect(existsSync(second)).toBe(false)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("MEASURE: effectiveSandboxMode scan cost", async () => {
    // A REGRESSION GUARD, not a reproduction. Three things it does not do, all
    // deliberate and all recorded in spec §7:
    //   - it calls `effectiveSandboxMode` DIRECTLY, the path no production
    //     caller takes (production goes through `sandboxPolicyNow()`, which
    //     slices from the policy floor first), so it cannot see that slice;
    //   - its only output is the `console.log` below, which nothing reads;
    //   - nothing here reproduces the 0.056-0.125 ms figure §7 originally
    //     quoted (five clean runs printed 0.099-0.274 ms/call), so that figure
    //     is recorded as one uncontrolled observation.
    // The bound is 2 ms; it was 5. MEASURED, so nobody has to guess what the
    // tightening buys: on the quiet run that set it this case prints
    // ~0.09 ms/call, and a semantically identical 10x-scan mutation printed
    // ~1.00 ms/call - so a 10x regression passes BOTH bounds. 2 ms fires at
    // roughly 20x on a quiet machine and ~7x on the loaded one that printed
    // 0.274. This is a ceiling against catastrophic regressions, not a 10x
    // detector; a real detector needs the benchmark harness IH does not have.
    const { effectiveSandboxMode } = await import("@i-harness/sandbox-policy")
    const session = createSession()
    for (let i = 0; i < 20_000; i += 1) append(session, { type: "user/message", text: "x" })
    const t0 = performance.now()
    for (let i = 0; i < 1_000; i += 1) effectiveSandboxMode(session.events)
    const perCall = (performance.now() - t0) / 1_000
    console.log(`scan over ${session.events.length} events: ${perCall.toFixed(3)} ms/call`)
    expect(perCall).toBeLessThan(2)
  })

  it("the assembly records the mode it starts under, so the resolver has a producer", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-producer-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const session = createSession()
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: modelWritingTargets([]),
      sandbox: "read-only",
    })
    try {
      const modes = session.events.filter((e) => e.type === "sandbox/mode")
      expect(modes).toHaveLength(1)
      expect(modes[0]).toMatchObject({ type: "sandbox/mode", mode: "read-only" })
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("negative control: an assembly with no sandbox option writes no sandbox/mode event", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-producer-none-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const session = createSession()
    const assembly = await createSessionAssembly({ workspace, session, model: modelWritingTargets([]) })
    try {
      expect(session.events.filter((e) => e.type === "sandbox/mode")).toHaveLength(0)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
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
 * session's decisions. The reviewer's finding was that the opposite behavior was
 * live and untested, with Task 3's escalation ladder as the producer that would
 * make it reachable in production.
 *
 * WHAT THIS CASE NO LONGER PINS (M1 Phase B, Task 1 -- disclosure, not a seam).
 * The OUTCOME below is still asserted and still valid: restored history does not
 * decide the mode. But the `policyFloor` slice is no longer INDEPENDENTLY
 * OBSERVABLE here, so this case is no longer a mutation detector for it.
 *
 * Mechanism. The log is now `[user/message, sandbox/mode danger-full-access
 * (restored), sandbox/mode read-only (the producer's construction-time append)]`.
 * `effectiveSandboxMode` is a BACKWARDS scan, and the producer's append is the
 * NEWEST event, so it returns `read-only` in BOTH worlds -- with
 * `slice(policyFloor)` and without it. Delete the slice and this case still
 * passes. Before the producer the retained window was empty, so the configured
 * `read-only` won only BECAUSE of the slice, and removing it let the restored
 * `danger-full-access` win -- the case went red, which is what made it a test.
 *
 * Consequences, recorded rather than papered over:
 *  - `policyFloor` has NO mutation-detecting test. A repo-wide grep finds it only
 *    in `assembly.ts` (the definition, two comments, the slice) and in a comment
 *    in `apps/cli/src/run.ts` -- no test references it.
 *  - It is not dead code: it is cheap defence-in-depth on a privilege-escalation
 *    path, and it is REDUNDANT only GIVEN this producer, whose append always
 *    supplies the newest event. It becomes load-bearing again the moment that
 *    append becomes conditional -- e.g. a host that states no `sandbox` option,
 *    or a future change that appends only on a mode CHANGE.
 *  - The guard is deliberately NOT exported to make it testable again: that would
 *    be the "test-only surface living in production code" this file's header
 *    rejects (lines 21-23). The slice stays private.
 */
describe("restored history does not decide the sandbox mode", () => {
  it("a persisted sandbox/mode event does NOT override the mode this run requested (OUTCOME only -- the policyFloor slice is no longer independently pinned; see the block comment)", async () => {
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

  it("a distinct policySession is what resolution reads, not the live session", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-policy-session-"))
    const workspace = join(base, "ws")
    const outside = join(base, "outside")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const first = join(outside, "first.txt")
    const second = join(outside, "second.txt")
    const live = createSession()
    const policySession = createSession()
    append(live, { type: "user/message", text: "go" })
    const assembly = await createSessionAssembly({
      workspace, session: live, policySession,
      model: modelWritingTargets([first, second]),
      approveAll: true,
      sandbox: "danger-full-access",
    })
    try {
      // CONTROL: the LIVE session tightens. Resolution does not read it, so the
      // write still lands — this is what makes the next assertion meaningful
      // rather than a test that would pass if resolution read nothing at all.
      append(live, { type: "sandbox/mode", mode: "read-only" })
      await runTurn(assembly)
      expect(readFileSync(first, "utf8")).toBe("escaped")

      // The resolution session tightens; the NEXT call must obey it.
      append(policySession, { type: "sandbox/mode", mode: "read-only" })
      await runTurn(assembly)
      expect(existsSync(second)).toBe(false)
    } finally { await assembly.dispose(); rmSync(base, { recursive: true, force: true }) }
  })
})

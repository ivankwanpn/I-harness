import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMockClient } from "@i-harness/llm-mock"
import { createSession, append } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import type { SandboxDenial } from "@i-harness/sandbox"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"

/**
 * The SHELL half of per-call resolution: the assembly → shell hand-off.
 *
 * `sandboxPolicyAtMount` was the last mount-time snapshot in the assembly, and it
 * fed `registerShell`. Converting it to `sandboxPolicyNow` was the one line that
 * made the shell half of this task REAL in production — and until this file it had
 * no test that could fail. A thunk over the mount-time value
 * (`() => sandboxPolicyAtMount`) typechecks, passes every session-executor test,
 * and passes the CLI confinement test: every existing test either mounts the mode
 * it means to assert or asserts on the fs guard, so none of them can see whether
 * the SHELL read a stale value.
 *
 * WHY THIS SHAPE. The property under test is "the policy the shell hands to exec
 * on THIS call is the mode in force on THIS call". Observing that from outside
 * needs the command to leave a trace, and the trace must be one the run cannot
 * produce by other means. So:
 *
 *  - mount at `danger-full-access` (no provider is composed for it), then append a
 *    TIGHTENING `sandbox/mode` event. The next bash call therefore carries a
 *    confined policy with no backend to confine it → `exec`'s `resolveArgv` fails
 *    CLOSED with SANDBOX_UNAVAILABLE, before any child process exists.
 *  - a stale mount-time value is `danger-full-access`, which is passthrough, so the
 *    command runs unconfined and echoes normally. The two behaviors are opposite
 *    and both are observable in the model-facing tool result.
 *
 * HOW THE REFUSAL SURFACES (M62 Task 3 changed this; read the change before
 * touching the assertion): it used to be a THROWN `SandboxUnavailableError` that
 * failed the turn, because `exec`'s `resolveArgv` throws synchronously and no
 * `tool/result` was ever appended. That made ONE bash call end the turn and left
 * the model with nothing to adapt to — the opposite of a rule it can follow. The
 * shell tools now CATCH that error and RETURN the refusal as a `SandboxDenial`,
 * so the turn resolves and the model reads why. What did NOT change: no command
 * runs, so `existsSync(trace)` stays false. That check is the independent proof
 * that nothing executed, and it is the part that must survive — a version of
 * this test that only looked at the returned JSON would pass against an
 * implementation that swallowed the refusal and ran the command anyway.
 *
 * This is the escalation-ladder shape in the other direction (a session-mode event
 * tightening a session that started permissive), which is exactly why the snapshot
 * had to go. Reachability note: the assembly composes no provider for
 * danger-full-access, and by design it must not — so "confined policy, no backend"
 * is a real state here, and refusing to run is the honest outcome, not a bug to
 * paper over. Asserting the refusal pins the fail-closed contract at the same time.
 */

/** One real turn on the assembly's session, drained to completion. */
async function runTurn(assembly: SessionAssembly): Promise<void> {
  const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
  executor.submit({ tier: "send", text: "go" })
  await executor.drain()
}

function modelCallingBash(command: string) {
  return createMockClient([
    { role: "assistant", toolCalls: [{ name: "bash", args: { command } }] },
    { role: "assistant", text: "done" },
  ])
}

describe("the assembly hands the shell a per-call policy", () => {
  it("a mid-session mode change reaches the NEXT shell command", async () => {
    const base = mkdtempSync(join(tmpdir(), "i-harness-shell-percall-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    // The trace: if the command is allowed to run at all, this appears. The
    // directory is deliberately absent so the write cannot succeed silently.
    const trace = join(workspace, "ran-through")
    const session = createSession()
    append(session, { type: "user/message", text: "run it" })
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: modelCallingBash(`mkdir -p ${JSON.stringify(trace)}`),
      approveAll: true,
      // Permissive at mount — so a value captured at mount can only ever be
      // permissive, whatever happens to the session afterwards.
      sandbox: "danger-full-access",
    })
    try {
      // The mid-session change. No reassembly, no new assembly — the same one the
      // snapshot was taken from.
      append(session, { type: "sandbox/mode", mode: "read-only" })

      // The shell resolved the NEW mode: the command carried a confined policy, so
      // exec refused to run it unconfined and the child never existed. The turn
      // RESOLVES: the refusal is a returned tool result the model can read, not a
      // throw that ends its turn with no `tool/result` at all.
      await expect(runTurn(assembly)).resolves.toBeUndefined()
      const result = session.events.find((e) => e.type === "tool/result" && e.name === "bash")
      expect(result, "the model must receive the refusal as a tool result").toBeDefined()
      const output = (result as { output?: { stderr?: string } }).output
      const denial = JSON.parse(output!.stderr!) as SandboxDenial
      expect(denial).toMatchObject({ code: "SANDBOX_DENIED", surface: "shell", mode: "read-only" })
      // The refusal must NOT advertise an escalation: no backend exists for ANY
      // mode here, so sending the model to ask for a wider one points it at a
      // request that cannot help.
      expect(denial.escalation).toBeUndefined()
      expect(JSON.stringify(denial)).not.toContain("sandbox_permissions")
      // The independent proof that nothing ran — unchanged by the conversion.
      expect(existsSync(trace)).toBe(false)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("CONTROL: with no mode change the same call still runs (the refusal is the mode, not the tool)", async () => {
    // Without this, the test above could pass against an assembly that refuses
    // every shell call for reasons that have nothing to do with resolution.
    const base = mkdtempSync(join(tmpdir(), "i-harness-shell-percall-ctl-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const session = createSession()
    append(session, { type: "user/message", text: "run it" })
    const assembly = await createSessionAssembly({
      workspace,
      session,
      // `true` with no dependencies: nothing to resolve against a path, so the
      // control does not depend on the host's shell beyond bash existing.
      model: modelCallingBash("true"),
      approveAll: true,
      sandbox: "danger-full-access",
    })
    try {
      // Mounted permissive and never tightened → passthrough, exactly as before.
      await expect(runTurn(assembly)).resolves.toBeUndefined()
      const results = session.events.filter((e) => e.type === "tool/result")
      expect(results.length).toBeGreaterThan(0)
      expect(JSON.stringify(results)).not.toContain("SANDBOX_UNAVAILABLE")
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  })
})

import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMockClient } from "@i-harness/llm-mock"
import { createSession, append } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import type { SandboxDenial } from "@i-harness/sandbox"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"

/** Current standing mode must reach the next actual shell invocation. The local
 * backend is now composed for runtime mode changes, including assemblies that
 * start unrestricted. The independent trace asserts filesystem denial. */

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
      // A configured backend can report an actual policy denial and an escalation
      // option; the retired missing-provider path advertised neither.
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
    // M62 Task 3 review: the budget is explicit. This case spawns a real
    // `bash -c true` through a full assembly, and the default 5s left it on the
    // edge under load — `workspace-cwd.test.ts` gives the identical call 30_000
    // for the same reason. The refusal case above needs no budget (it never
    // spawns), so only this one carries the override.
  }, 30_000)
})

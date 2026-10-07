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

const toolName = process.platform === "win32" ? "shell" : "bash"
const qualifiedShell = process.platform === "win32" ? { agentShell: () => ({ id: "powershell", label: "Windows PowerShell", dialect: "powershell" as const,
  command: join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe") }) } : {}
const mkdirCommand = (path: string) => process.platform === "win32"
  ? `New-Item -ItemType Directory -Path '${path.replaceAll("'", "''")}' -ErrorAction Stop`
  : `mkdir -p ${JSON.stringify(path)}`
function modelCallingShell(command: string) {
  return createMockClient([
    { role: "assistant", toolCalls: [{ name: toolName, args: { command } }] },
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
      model: modelCallingShell(mkdirCommand(trace)),
      ...qualifiedShell,
      approveAll: true,
      // Permissive at mount — so a value captured at mount can only ever be
      // permissive, whatever happens to the session afterwards.
      sandbox: "danger-full-access",
    })
    try {
      // The mid-session change. No reassembly, no new assembly — the same one the
      // snapshot was taken from.
      append(session, { type: "sandbox/mode", mode: "read-only" })

      // The shell resolves the new mode. On Windows the qualified native shell
      // starts under the readonly policy and the OS denies its filesystem write.
      // The turn still resolves with the actual failure as a tool result.
      await expect(runTurn(assembly)).resolves.toBeUndefined()
      const result = session.events.find((e) => e.type === "tool/result" && e.name === toolName)
      expect(result, "the model must receive the refusal as a tool result").toBeDefined()
      const output = (result as { output?: { stderr?: string; exitCode?: number } }).output
      if (process.platform === "win32") {
        // A qualified shell reaches the real filesystem denial. Its native
        // stderr is distinct from the structured failure to initialize MSYS.
        expect(output!.exitCode).not.toBe(0)
        expect(output!.stderr).toMatch(/PermissionDenied|CreateDirectoryUnauthorizedAccessError/)
      } else {
        const denial = JSON.parse(output!.stderr!) as SandboxDenial
        expect(denial).toMatchObject({ code: "SANDBOX_DENIED", surface: "shell", mode: "read-only" })
      }
      // Independent filesystem proof that the forbidden operation did not occur.
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
    const trace = join(workspace, "ran-through")
    const assembly = await createSessionAssembly({
      workspace,
      session,
      model: modelCallingShell(mkdirCommand(trace)),
      ...qualifiedShell,
      approveAll: true,
      sandbox: "danger-full-access",
    })
    try {
      // Mounted permissive and never tightened → passthrough, exactly as before.
      await expect(runTurn(assembly)).resolves.toBeUndefined()
      const results = session.events.filter((e) => e.type === "tool/result")
      expect(results.length).toBeGreaterThan(0)
      expect(JSON.stringify(results)).not.toContain("SANDBOX_UNAVAILABLE")
      expect(existsSync(trace)).toBe(true)
    } finally {
      await assembly.dispose()
      rmSync(base, { recursive: true, force: true })
    }
    // Preserve the existing real-shell control's explicit time budget.
  }, 30_000)
})

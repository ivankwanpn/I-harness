// W10: a foreground shell command's escape hatch from the deadline, end to end.
//
// WHAT WAS WRONG. A foreground bash/pwsh call carries the assembly's
// `shellTimeoutMs` (default 120s) as the tool's declared deadline, and at it
// guard-timeout ABORTS the call — exec kills the process tree and the model
// reads `tool call timed out after 120000ms`. A ten-minute `docker build` was
// not slow: it died mid-flight and its work was lost. `background: true` exists
// but the model must guess BEFORE the command runs; nothing promoted a command
// that simply took longer than expected.
//
// WHAT THIS FILE PINS. The promotion is proven on the REAL stack — a real
// assembly, the real guard, the real exec service, a real shell — because the
// seam it crosses (guard-timeout's abort signal → exec's spawn → the job
// registry) has no observable stand-in: a fake exec would prove the mapping and
// nothing about the survival.
//
// WHY THE COMMAND'S SECOND HALF IS HELD OPEN BY A FILE. The property under test
// is "the command is STILL RUNNING when the tool returns, and it finishes its
// work afterwards". If the command had a fixed duration, both halves would be
// timing races that a loaded machine could flip. Here the command CANNOT finish
// until this test creates the release file, and the test creates it only after
// reading the running job — so no assertion depends on wall-clock headroom.
//
// The falsification case is the other half of the same fact: the threshold is
// only an escape hatch while it is UNDER the deadline. Set above it, the abort
// wins the race, nothing is promoted, and the command dies exactly as it did
// before W10 — which is the misconfiguration the comment beside the two
// defaults warns about.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import { append, createSession } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import { resolveShell } from "@i-harness/shell"
import type { ExecService } from "@i-harness/exec"
import { createSessionAssembly, type SessionAssembly } from "../src/assembly.ts"
import { rmWorkspaceSync } from "./helpers.ts"

const fwd = (p: string): string => p.replace(/\\/g, "/")

/** One real turn on the assembly's session, drained to completion. */
async function runTurn(assembly: SessionAssembly): Promise<void> {
  const executor = createSessionExecutor({ session: assembly.session, agent: assembly.agent, inbox: assembly.inbox })
  executor.submit({ tier: "send", text: "go" })
  await executor.drain()
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met within budget")
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** A command that prints `started`, then WAITS for `release` to exist, then
 * writes `donePath` and prints nothing more. Its first half is what a promoted
 * job's view must already contain; its second half is the work the 120s death
 * would have destroyed, and it happens only when this test says so. */
function heldOpenCommand(shell: "bash" | "pwsh", release: string, donePath: string): string {
  const rel = fwd(release)
  const done = fwd(donePath)
  return shell === "bash"
    ? `echo started; while [ ! -f "${rel}" ]; do sleep 0.2; done; echo finished > "${done}"`
    : `Write-Output started; while (!(Test-Path '${rel}')) { Start-Sleep -Milliseconds 200 }; Set-Content -Path '${done}' -Value finished`
}

const quickCommand = (shell: "bash" | "pwsh"): string => (shell === "bash" ? "echo hi" : "Write-Output hi")

type ToolResultOutput = Record<string, unknown>

function toolResult(session: SessionAssembly["session"], name: string): ToolResultOutput {
  const event = session.events.filter((e) => e.type === "tool/result" && e.name === name).at(-1)
  expect(event, `the model must receive a tool/result for ${name}`).toBeDefined()
  return (event as { output?: ToolResultOutput }).output ?? {}
}

async function mountAssembly(
  workspace: string,
  model: ReturnType<typeof createMockClient>,
  shellTimeoutMs: number,
  /** Absent → the assembly's own default (30_000) applies. */
  shellBackgroundAfterMs?: number,
): Promise<SessionAssembly> {
  const session = createSession()
  append(session, { type: "user/message", text: "go" })
  return createSessionAssembly({
    workspace,
    session,
    model,
    approveAll: true,
    shellTimeoutMs,
    ...(shellBackgroundAfterMs !== undefined ? { shellBackgroundAfterMs } : {}),
  })
}

describe("W10: a foreground shell command that outlives its promotion threshold", () => {
  it("is handed back as a job id, the job is still RUNNING, job_output reads it — and the command then finishes its work", async () => {
    const shell = resolveShell().name
    const base = mkdtempSync(join(tmpdir(), "i-harness-w10-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const release = join(base, "release")
    const donePath = join(base, "done.txt")
    // The script is MUTABLE on purpose: `createMockClient` consumes the array it
    // was handed, so the second turn's step is spliced in only once the first
    // turn's job id exists. The test never has to guess an id, and it never
    // hardcodes one.
    const script: MockStep[] = [
      { role: "assistant", toolCalls: [{ name: shell, args: { command: heldOpenCommand(shell, release, donePath) } }] },
      { role: "assistant", text: "waiting" },
    ]
    // The deadline is 5s and the threshold 300ms: the hand-back must happen long
    // before the abort, which is the relationship the assembly's comment states.
    const assembly = await mountAssembly(workspace, createMockClient(script), 5_000, 300)
    try {
      await runTurn(assembly)

      // 1. The result SAYS it was promoted — it is not a `{ job_id }` the model
      //    could mistake for its own `background: true`, and not a failure.
      const output = toolResult(assembly.session, shell)
      expect(output.promoted).toBe(true)
      expect(output.ran_foreground_ms).toBeGreaterThanOrEqual(300)
      expect(output.job_id).toMatch(/^bash-\d+$/)
      expect(output.code).toBeUndefined() // not the TOOL_TIMEOUT death
      expect(output.exitCode).toBeUndefined() // and not a finished command either
      const jobId = output.job_id as string

      // 2. The command SURVIVED the hand-back: the job record is live, and the
      //    command is held open by a file this test has not written yet, so
      //    "running" here cannot be a race.
      const exec = assembly.ctx.services.get<ExecService>("exec/service")
      expect(exec.getOutput(jobId).status).toBe("running")
      expect(existsSync(donePath)).toBe(false)

      // 3. job_output — the surface the model reaches for — reads the promoted
      //    job, including the output produced BEFORE the hand-back.
      script.push(
        { role: "assistant", toolCalls: [{ name: "job_output", args: { job_id: jobId } }] },
        { role: "assistant", text: "checked" },
      )
      await runTurn(assembly)
      const read = toolResult(assembly.session, "job_output")
      expect(read.text).toContain("started")
      expect(read.text).toContain("[status: running]")

      // 4. The work is NOT lost: release the command and watch it complete.
      writeFileSync(release, "go")
      await waitFor(() => exec.getOutput(jobId).status === "completed")
      expect(exec.getOutput(jobId).exitCode).toBe(0)
      expect(existsSync(donePath)).toBe(true)
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(base)
    }
  }, 30_000)

  it("a command that finishes under the threshold returns exactly today's inline result — no id, no job", async () => {
    const shell = resolveShell().name
    const base = mkdtempSync(join(tmpdir(), "i-harness-w10-quick-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    // The knob is ON: this is the control that proves a short command's shape is
    // untouched by the feature that watches it. (Threshold 5s: an `echo` cannot
    // plausibly reach it, so the assertion is not a timing race.)
    const assembly = await mountAssembly(
      workspace,
      createMockClient([
        { role: "assistant", toolCalls: [{ name: shell, args: { command: quickCommand(shell) } }] },
        { role: "assistant", text: "done" },
      ]),
      10_000,
      5_000,
    )
    try {
      await runTurn(assembly)
      const output = toolResult(assembly.session, shell)
      expect(output.stdout).toContain("hi")
      expect(output.exitCode).toBe(0)
      expect(output.job_id).toBeUndefined()
      expect(output.promoted).toBeUndefined()
      expect(output.ran_foreground_ms).toBeUndefined()
      const exec = assembly.ctx.services.get<ExecService>("exec/service")
      expect(exec.listJobs()).toEqual([])
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(base)
    }
  }, 30_000)

  it("FALSIFICATION: a threshold ABOVE the deadline never fires — the command dies, and dies branded as a timeout", async () => {
    const shell = resolveShell().name
    const base = mkdtempSync(join(tmpdir(), "i-harness-w10-falsify-"))
    const workspace = join(base, "ws")
    mkdirSync(workspace, { recursive: true })
    const release = join(base, "release")
    const donePath = join(base, "done.txt")
    // NO threshold is passed: this is the shipped default (30_000), and 30_000
    // against a 400ms deadline is above it by two orders of magnitude, so the
    // abort wins the race by construction. (That is deliberate — the default is
    // otherwise only observable by waiting thirty seconds, and a future default
    // moved under this deadline would flip this test red rather than silently
    // hollow it out.) The command is the same held-open one as above; it can
    // only end by being killed or by the release file, which this test never
    // writes.
    const assembly = await mountAssembly(
      workspace,
      createMockClient([
        { role: "assistant", toolCalls: [{ name: shell, args: { command: heldOpenCommand(shell, release, donePath) } }] },
        { role: "assistant", text: "done" },
      ]),
      400,
    )
    try {
      await runTurn(assembly)
      const output = toolResult(assembly.session, shell)
      // The death is observable as a TIMEOUT, not as an ordinary command
      // failure — that part of the contract predates W10 and must survive it.
      expect(output.code).toBe("TOOL_TIMEOUT")
      expect(output.error).toContain("timed out after 400ms")
      // And the promotion never fired: no id, no announcement, no job record.
      expect(output.promoted).toBeUndefined()
      expect(output.job_id).toBeUndefined()
      const exec = assembly.ctx.services.get<ExecService>("exec/service")
      expect(exec.listJobs()).toEqual([])
      // The work is gone (the command was killed before it could finish) — the
      // failure mode this test exists to keep visible.
      expect(existsSync(donePath)).toBe(false)
    } finally {
      await assembly.dispose()
      rmWorkspaceSync(base)
    }
  }, 30_000)
})

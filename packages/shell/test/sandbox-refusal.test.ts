import { describe, expect, it } from "vitest"
import type { ExecCommand, ExecService } from "@i-harness/exec"
import type { SandboxDenial } from "@i-harness/sandbox"
import { SandboxUnavailableError } from "@i-harness/sandbox"
import type { Tool } from "@i-harness/core-tools"
import { bashAvailable, createShellTools } from "../src/index.ts"

/**
 * M62 Task 3 (Step 7): ALL FOUR refusal call sites must RETURN, not throw.
 *
 * The brief was explicit that there are "four call sites, not two": `exec`'s
 * `resolveArgv` throws `SandboxUnavailableError` SYNCHRONOUSLY
 * (`packages/exec/src/index.ts:112,122`) and the background path reaches it
 * through `spawnChild`, in `runBackground`, from a DIFFERENT call site than the
 * foreground `run` — four in all: `runBackground` and `run` in each of the bash
 * and pwsh tool bodies of `packages/shell/src/index.ts`. (Named by SYMBOL, not by
 * line number: this comment has now cited three different sets of numbers as the
 * file moved under it — the pre-M62 ones, then the ones from before
 * `sandboxUnavailableFailure` was inserted, then those plus this task's ladder.
 * A symbol cannot rot.) Wrapping only the `await deps.exec.run(...)` path
 * typechecks, passes the end-to-end suite, and leaves a background call killing
 * the turn — which is exactly the behaviour this change exists to remove.
 *
 * WHY THIS FILE EXISTS IN ADDITION TO `session-executor`'s END-TO-END TEST: the
 * assembly-level test drives ONE bash call, on the foreground path, and it needs
 * WSL `bash` on PATH to get that far. A fake `ExecService` here reaches all four
 * paths on any host, with no child process, no PTY and no timing budget. The
 * end-to-end test proves the behaviour is reachable in production; this one
 * proves it is reachable on EVERY path.
 */

/** An `ExecService` that refuses every call exactly as `exec` refuses one:
 *  SYNCHRONOUSLY from `runBackground`, and as a rejected promise from `run`. */
function refusingExec(): ExecService {
  const refuse = (cmd: ExecCommand): never => {
    // Only a confined policy can produce this in production (`resolveArgv` is a
    // passthrough for `danger-full-access`), so the fake honours that and fails
    // loudly if the tools ever call it unconfined — otherwise the test could not
    // tell "the refusal was caught" from "no refusal happened".
    const policy = cmd.sandbox
    if (policy === undefined || policy.mode === "danger-full-access") {
      throw new Error(`refusingExec: no confined policy on this command (sandbox=${String(policy?.mode)})`)
    }
    throw new SandboxUnavailableError(policy.mode, "no sandbox provider composed (createExecService({ sandbox }))")
  }
  return {
    run: async (cmd) => refuse(cmd),
    runBackground: (cmd) => refuse(cmd),
    getOutput: () => {
      throw new Error("refusingExec: getOutput must not be reached")
    },
    killJob: () => "already-finished",
    listJobs: () => [],
  }
}

const toolNamed = (name: string): Tool => {
  const tool = createShellTools({
    exec: refusingExec(),
    // Confined, so `exec` is handed a policy and refuses it.
    sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    cwd: "/ws",
  }).find((t) => t.name === name)
  if (!tool) throw new Error(`no tool named ${name}`)
  return tool
}

/** The denial carried by a returned refusal, parsed the way the model would. */
function denialOf(output: { stdout?: string; stderr?: string; exitCode?: number } | undefined): SandboxDenial {
  expect(output?.stderr, "the refusal must be a returned `stderr`, not a rejection").toBeTypeOf("string")
  // A rejected promise reaching here would have failed the test already; a
  // refusal that returned the raw error message instead of the shared type would
  // fail this parse.
  return JSON.parse(output!.stderr!) as SandboxDenial
}

function check(output: { stdout?: string; stderr?: string; exitCode?: number } | undefined, surface: string) {
  const denial = denialOf(output)
  expect(denial).toMatchObject({ code: "SANDBOX_DENIED", surface, mode: "read-only" })
  // Constraint 1: no backend is usable for ANY mode here, so the refusal must not
  // send the model to ask for a wider one.
  expect(denial.escalation).toBeUndefined()
  expect(JSON.stringify(denial)).not.toContain("sandbox_permissions")
  // -1 mirrors the bash-absent branch: "this host could not run it", never
  // "it ran and failed".
  expect(output!.exitCode).toBe(-1)
}

describe("a sandbox-unavailable refusal is RETURNED on every path", () => {
  // pwsh first: it has no host-availability branch, so it reaches `exec` on every
  // platform. bash is gated by `bashAvailable()` and is covered below.
  it("pwsh foreground returns the refusal instead of rejecting", async () => {
    check(await toolNamed("pwsh").execute({ command: "true" }, {}) as never, "shell")
  })

  it("pwsh background returns the refusal instead of rejecting", async () => {
    check(await toolNamed("pwsh").execute({ command: "true", background: true }, {}) as never, "shell")
  })

  it("bash foreground returns the refusal instead of rejecting", async () => {
    // Hosts without bash take the pre-existing "bash is not installed" branch
    // (which is itself a returned refusal — the M59 precedent this follows), so
    // the sandbox refusal is only reachable where the tool would actually spawn.
    if (!bashAvailable()) return
    check(await toolNamed("bash").execute({ command: "true" }, {}) as never, "shell")
  })

  it("bash background returns the refusal instead of rejecting", async () => {
    if (!bashAvailable()) return
    check(await toolNamed("bash").execute({ command: "true", background: true }, {}) as never, "shell")
  })

  it("a NON-sandbox failure still rejects (the catch is not a blanket swallow)", async () => {
    const boom = new Error("spawn ENOENT")
    const exec: ExecService = {
      run: async () => { throw boom },
      runBackground: () => { throw boom },
      getOutput: () => { throw boom },
      killJob: () => "already-finished",
      listJobs: () => [],
    }
    const pwsh = createShellTools({
      exec,
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    }).find((t) => t.name === "pwsh")!
    await expect(pwsh.execute({ command: "true" }, {})).rejects.toThrow("spawn ENOENT")
  })
})

// ── The escalation ladder on the shell surface ──────────────────────────────
//
// The shell runs the SAME per-call ladder as fs and the terminal, at the top of
// its body — but where fs hands the granted MODE to a synchronous guard, the
// shell hands the granted POLICY to `exec`. Two traps this pins:
//
//  1. After a grant, the confinement decision must use `resolution.policy`. A
//     second read of `deps.sandboxPolicy?.()` (the session's standing mode)
//     would refuse the very call the user just approved.
//  2. The `SandboxUnavailableError` catch must NOT consult the ladder: that
//     refusal means no backend exists for ANY mode, so no mode can be advised.

/** An `ExecService` that records the policy each call carried and succeeds. */
function recordingExec() {
  const policies: Array<{ mode?: string } | undefined> = []
  const exec: ExecService = {
    run: async (cmd) => {
      policies.push(cmd.sandbox as { mode?: string } | undefined)
      return { stdout: "ran", stderr: "", exitCode: 0, timedOut: false }
    },
    runBackground: (cmd) => {
      policies.push(cmd.sandbox as { mode?: string } | undefined)
      return { jobId: "job-1" }
    },
    getOutput: () => { throw new Error("recordingExec: getOutput must not be reached") },
    killJob: () => "already-finished",
    listJobs: () => [],
  }
  return { exec, policies }
}

function approverSaying(outcome: "allowed-once" | "rejected") {
  const prompts: Array<{ toolName: string; callId: string; reason: string }> = []
  return {
    prompts,
    approver: {
      async request(req: { toolName: string; callId: string; reason: string }) {
        prompts.push({ toolName: req.toolName, callId: req.callId, reason: req.reason })
        return outcome
      },
    },
  }
}

const escalatingPwsh = (
  exec: ExecService,
  approver: unknown,
  mode: "read-only" | "workspace-write" = "read-only",
) =>
  createShellTools({
    exec,
    sandboxPolicy: () => ({ mode, workspaceRoot: "/ws" }),
    escalationApprover: approver as never,
  }).find((t) => t.name === "pwsh")!

describe("shell escalation ladder", () => {
  it("an approved escalation runs the call under the GRANTED mode, not the session's", async () => {
    const { exec, policies } = recordingExec()
    const { approver, prompts } = approverSaying("allowed-once")
    const result = await escalatingPwsh(exec, approver).execute(
      { command: "true", sandbox_permissions: "workspace-write", justification: "the command writes outside the workspace" },
      { callId: "call-9" },
    )
    expect(result).toMatchObject({ stdout: "ran", exitCode: 0 })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.toolName).toBe("pwsh")
    expect(prompts[0]!.reason).toContain("run ") // the operation is named
    // THE assertion: the policy exec receives is the GRANTED one. A fresh read of
    // the session thunk would carry `read-only` here and refuse the call the user
    // just approved.
    expect(policies).toEqual([{ mode: "workspace-write", workspaceRoot: "/ws" }])
  })

  it("a refused escalation is RETURNED, and the command never reaches exec", async () => {
    const { exec, policies } = recordingExec()
    const { approver } = approverSaying("rejected")
    const result = (await escalatingPwsh(exec, approver).execute(
      { command: "true", sandbox_permissions: "workspace-write", justification: "please" },
      {},
    )) as { stdout?: string; stderr?: string; exitCode?: number }
    const denial = JSON.parse(result.stderr!) as SandboxDenial
    expect(denial).toMatchObject({ code: "SANDBOX_DENIED", surface: "shell", mode: "read-only" })
    // The request was refused, not the operation: no escalation sentence may be
    // re-attached (§3.2 corollary 2).
    expect(denial.escalation).toBeUndefined()
    expect(result.exitCode).toBe(-1)
    expect(policies).toHaveLength(0)
  })

  it("a malformed escalation pair is refused with the validation message", async () => {
    const { exec } = recordingExec()
    const result = (await escalatingPwsh(exec, approverSaying("allowed-once").approver).execute(
      { command: "true", sandbox_permissions: "workspace-write" },
      {},
    )) as { stderr?: string }
    const denial = JSON.parse(result.stderr!) as SandboxDenial
    expect(denial.reason).toMatch(/justification/)
    expect(denial.escalation).toBeUndefined()
  })

  it("no escalation arguments means exec sees the session's mode and nobody is asked", async () => {
    const { exec, policies } = recordingExec()
    const { approver, prompts } = approverSaying("allowed-once")
    const result = await escalatingPwsh(exec, approver).execute({ command: "true" }, {})
    expect(result).toMatchObject({ exitCode: 0 })
    expect(prompts).toHaveLength(0)
    expect(policies).toEqual([{ mode: "read-only", workspaceRoot: "/ws" }])
  })

  it("the sandbox-unavailable refusal keeps its no-hint denial and never asks", async () => {
    // The ladder must NOT be consulted in the SandboxUnavailableError catch: no
    // backend exists for ANY mode there, so escalation cannot help. This is the
    // direction that was got backwards once already.
    const { approver, prompts } = approverSaying("allowed-once")
    const tools = createShellTools({
      exec: refusingExec(),
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
      escalationApprover: approver as never,
    })
    const result = await tools.find((t) => t.name === "pwsh")!.execute({ command: "true" }, {}) as never
    const denial = denialOf(result)
    expect(denial.escalation).toBeUndefined()
    expect(prompts).toHaveLength(0)
  })
})

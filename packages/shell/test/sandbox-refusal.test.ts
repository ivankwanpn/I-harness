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
 * through `spawnChild` on a DIFFERENT line from the foreground one
 * (`packages/shell/src/index.ts:307` vs `:309` for bash, `:343` vs `:345` for
 * pwsh). Wrapping only the `await deps.exec.run(...)` line typechecks, passes
 * the end-to-end suite, and leaves a background call killing the turn — which is
 * exactly the behaviour this change exists to remove.
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

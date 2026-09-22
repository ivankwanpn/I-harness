import { describe, expect, it } from "vitest"
import type { ExecCommand, ExecService } from "@i-harness/exec"
import type { SandboxExecutionPolicy } from "@i-harness/sandbox"
import type { Tool } from "@i-harness/core-tools"
import type { PluginContext } from "@i-harness/core-plugin"
import { createShellTools, registerShell } from "../src/index.ts"

/**
 * M62: the shell must resolve the session's sandbox policy at EACH CALL.
 *
 * `ShellToolDeps.sandboxPolicy` used to be a resolved VALUE, captured once when
 * the assembly registered the tools. The assembly resolved it at MOUNT time, so a
 * `sandbox/mode` event appended mid-session (the escalation ladder appends one)
 * reached the fs write guard — which Task 1 converted to a per-call read — while
 * the shell kept confining against the mode that was in force when the session
 * opened. The two surfaces then disagreed about the mode in force, which is worse
 * than either being wrong on its own: the model is told one rule and enforced by
 * another.
 *
 * The option is now a thunk. What these tests pin down is not "the policy is
 * passed" (that was already true) but "the function is invoked PER EXECUTION",
 * which is the property a mount-time snapshot silently loses.
 */

/** Capture the `sandbox` field of every exec call and answer minimally. */
function fakeExec(seen: Array<SandboxExecutionPolicy | undefined>) {
  const record = (cmd: ExecCommand) => { seen.push(cmd.sandbox) }
  const exec: ExecService = {
    run: async (cmd) => {
      record(cmd)
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }
    },
    runBackground: (cmd) => {
      record(cmd)
      return { jobId: "job-1" }
    },
    getOutput: () => ({ id: "job-1", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
    killJob: () => "already-finished",
    listJobs: () => [],
  }
  return exec
}

const toolNamed = (tools: Tool[], name: string) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool named ${name}`)
  return tool
}

describe("the shell resolves the sandbox policy per call", () => {
  it("passes the policy the resolver returns for THIS call", async () => {
    const seen: Array<SandboxExecutionPolicy | undefined> = []
    // The tool set is built ONCE, as the assembly builds it, and used for both
    // calls. Building it per call inside the test would re-run the resolver on
    // every construction and so would pass even against a mount-time snapshot —
    // the exact bug under test (this test was written that way first).
    const deps = {
      exec: fakeExec(seen),
      sandboxPolicy: () => ({ mode: "read-only" as const, workspaceRoot: "/ws" }),
      cwd: "/ws",
    }
    const bash = toolNamed(createShellTools(deps), "bash")
    await bash.execute({ command: "true" }, {})
    await bash.execute({ command: "true" }, {})
    expect(seen).toHaveLength(2)
    expect(seen[0]?.mode).toBe("read-only")
    // The cwd contract must survive the change (D1).
    expect(seen[0]?.workspaceRoot).toBe("/ws")
  })

  it("sees a mode change that happens DURING the session (the whole point)", async () => {
    // One tool set built ONCE, exactly as it is built at mount. The mode tightens
    // between the two calls. A snapshot taken at construction keeps saying
    // "workspace-write" forever; a per-call read cannot.
    const seen: Array<SandboxExecutionPolicy | undefined> = []
    let mode: SandboxExecutionPolicy["mode"] = "workspace-write"
    const deps = {
      exec: fakeExec(seen),
      sandboxPolicy: () => ({ mode, workspaceRoot: "/ws" }),
      cwd: "/ws",
    }
    const bash = toolNamed(createShellTools(deps), "bash")
    await bash.execute({ command: "true" }, {})
    mode = "read-only"
    await bash.execute({ command: "true" }, {})
    expect(seen.map((p) => p?.mode)).toEqual(["workspace-write", "read-only"])
  })

  it("resolves per call for background and foreground, bash and pwsh", async () => {
    const seen: Array<SandboxExecutionPolicy | undefined> = []
    let mode: SandboxExecutionPolicy["mode"] = "workspace-write"
    const deps = { exec: fakeExec(seen), sandboxPolicy: () => ({ mode, workspaceRoot: "/ws" }) }
    const tools = createShellTools(deps)
    const bash = tools.find((t) => t.name === "bash")!
    const pwsh = tools.find((t) => t.name === "pwsh")!
    await bash.execute({ command: "true" }, {})
    mode = "read-only"
    await bash.execute({ command: "bg", background: true }, {})
    mode = "danger-full-access"
    await pwsh.execute({ command: "true" }, {})
    await pwsh.execute({ command: "bg", background: true }, {})
    expect(seen.map((p) => p?.mode)).toEqual([
      "workspace-write", // bash, foreground
      "read-only", // bash, background
      "danger-full-access", // pwsh, foreground
      "danger-full-access", // pwsh, background
    ])
  })

  it("sends NO sandbox field when the resolver answers undefined", async () => {
    // A host that requested no sandbox (or danger-full-access, where the assembly
    // has no policy service) must keep the pre-M16 passthrough — an explicitly
    // undefined `sandbox` field is not the same contract as an absent one.
    const seen: Array<SandboxExecutionPolicy | undefined> = []
    const deps = { exec: fakeExec(seen), sandboxPolicy: () => undefined }
    const bash = toolNamed(createShellTools(deps), "bash")
    await bash.execute({ command: "true" }, {})
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeUndefined()
  })

  it("sends no sandbox field when no resolver is supplied at all", async () => {
    const seen: Array<SandboxExecutionPolicy | undefined> = []
    const bash = toolNamed(createShellTools({ exec: fakeExec(seen) }), "bash")
    await bash.execute({ command: "true" }, {})
    expect(seen[0]).toBeUndefined()
  })

  it("registerShell forwards the resolver to the registered tools", async () => {
    // The assembly reaches the tools through registerShell, so a conversion that
    // stopped at createShellTools would still leave the real path snapshotting.
    // registerShell builds its own exec service; the fake ctx hands the tool
    // closure the spy instead so the forwarded command is observable (the
    // pattern the D1 cwd test in shell.test.ts uses).
    const seen: Array<SandboxExecutionPolicy | undefined> = []
    const spyExec = fakeExec(seen)
    const ctx = { services: { register: () => {}, get: () => spyExec } } as unknown as PluginContext
    const tools: Tool[] = []
    registerShell(ctx, { register: (t) => tools.push(t) }, {
      sandboxPolicy: () => ({ mode: "read-only", workspaceRoot: "/ws" }),
    })
    const bash = tools.find((t) => t.name === "bash")!
    await bash.execute({ command: "true" }, {} as never)
    expect(seen[0]?.mode).toBe("read-only")
  })
})

import { describe, expect, it } from "vitest"
import { resolveShell, getArgv, createShellTools, registerShell } from "../src/index.ts"
import type { ExecService, ExecCommand } from "@i-harness/exec"
import type { Tool } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"

describe("resolveShell", () => {
  it("resolves to a shell (bash or pwsh) with a -c/-Command prefix", () => {
    const shell = resolveShell()
    expect(["bash", "pwsh"]).toContain(shell.name)
    expect(shell.argv.length).toBeGreaterThan(0)
  })
})

describe("getArgv (shell-quote parser)", () => {
  it("splits a simple command into argv", () => {
    expect(getArgv("rm -rf x")).toEqual(["rm", "-rf", "x"])
    expect(getArgv("echo hi")).toEqual(["echo", "hi"])
  })

  it("handles backslash escapes and quotes (F03-2 bypass shapes)", () => {
    expect(getArgv("r\\m -rf x")).toEqual(["rm", "-rf", "x"])
    expect(getArgv("'r''m' -rf x")).toEqual(["rm", "-rf", "x"])
    expect(getArgv('r""m -rf x')).toEqual(["rm", "-rf", "x"])
  })

  it("handles quoted arguments with spaces", () => {
    expect(getArgv('echo "hello world"')).toEqual(["echo", "hello world"])
  })
})

describe("createShellTools", () => {
  const fakeExec: ExecService = {
    run: async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
    runBackground: () => ({ jobId: "none" }),
    getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
    killJob: () => "already-finished",
    listJobs: () => [],
  }

  it("returns bash and pwsh tools carrying getArgv (for guard-approval)", () => {
    const [bash, pwsh] = createShellTools({ exec: fakeExec })
    expect(bash.name).toBe("bash")
    expect(pwsh.name).toBe("pwsh")
    expect(bash.getArgv?.({ command: "rm -rf x" })).toEqual(["rm", "-rf", "x"])
    expect(pwsh.getArgv?.({ command: 'echo "hi there"' })).toEqual(["echo", "hi there"])
  })

  it("bash tool execute hardcodes ['bash', '-c', ...] (no silent pwsh fallback)", async () => {
    let captured: string[] = []
    const spyExec: ExecService = {
      run: async (cmd) => {
        captured = cmd.argv
        return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }
      },
      runBackground: () => ({ jobId: "none" }),
      getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
      killJob: () => "already-finished",
    listJobs: () => [],
    }
    const [bash] = createShellTools({ exec: spyExec })
    const result = (await bash.execute({ command: "echo hi" }, {})) as {
      stdout: string
      exitCode: number
    }
    expect(result.stdout).toBe("ok")
    expect(result.exitCode).toBe(0)
    // Must be the exact bash form — NOT resolveShell()'s output (which can be
    // pwsh on a Windows host without bash on PATH).
    expect(captured).toEqual(["bash", "-c", "echo hi"])
  })

  it("pwsh tool execute constructs pwsh -Command argv", async () => {
    let captured: string[] = []
    const spyExec: ExecService = {
      run: async (cmd) => {
        captured = cmd.argv
        return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }
      },
      runBackground: () => ({ jobId: "none" }),
      getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
      killJob: () => "already-finished",
    listJobs: () => [],
    }
    const [, pwsh] = createShellTools({ exec: spyExec })
    await pwsh.execute({ command: "Get-Date" }, {})
    expect(captured).toEqual(["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-Date"])
  })

  it("bash tool with background:true returns a job id immediately", async () => {
    let ranBackground = false
    const fakeExec: ExecService = {
      run: async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }),
      runBackground: () => { ranBackground = true; return { jobId: "bash-1" } },
      getOutput: () => ({ id: "bash-1", status: "running", stdout: "", stderr: "" }),
      killJob: () => "already-finished",
    listJobs: () => [],
    }
    const [bash] = createShellTools({ exec: fakeExec })
    const result = await bash.execute({ command: "sleep 5", background: true }, {})
    expect(ranBackground).toBe(true)
    expect(result).toEqual({ job_id: "bash-1" })
  })

  it("declares timeoutMs on both tools when provided, else undefined", () => {
    const [bash, pwsh] = createShellTools({ exec: fakeExec, timeoutMs: 5000 })
    expect(bash.timeoutMs).toBe(5000)
    expect(pwsh.timeoutMs).toBe(5000)
    const [bash2, pwsh2] = createShellTools({ exec: fakeExec })
    expect(bash2.timeoutMs).toBeUndefined()
    expect(pwsh2.timeoutMs).toBeUndefined()
  })

  it("foreground bash execute forwards abortSignal into exec.run", async () => {
    let captured: ExecCommand | undefined
    const signal = new AbortController().signal
    const spyExec: ExecService = {
      run: async (cmd) => {
        captured = cmd
        return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }
      },
      runBackground: () => ({ jobId: "none" }),
      getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
      killJob: () => "already-finished",
      listJobs: () => [],
    }
    const [bash] = createShellTools({ exec: spyExec })
    await bash.execute({ command: "echo hi" }, { abortSignal: signal })
    expect(captured?.abortSignal).toBe(signal)
  })

  it("foreground pwsh execute forwards abortSignal into exec.run", async () => {
    let captured: ExecCommand | undefined
    const signal = new AbortController().signal
    const spyExec: ExecService = {
      run: async (cmd) => {
        captured = cmd
        return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }
      },
      runBackground: () => ({ jobId: "none" }),
      getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
      killJob: () => "already-finished",
      listJobs: () => [],
    }
    const [, pwsh] = createShellTools({ exec: spyExec })
    await pwsh.execute({ command: "Get-Date" }, { abortSignal: signal })
    expect(captured?.abortSignal).toBe(signal)
  })

  it("background executes do NOT pass an abortSignal (fire-and-forget)", async () => {
    let captured: ExecCommand | undefined
    const spyExec: ExecService = {
      run: async (cmd) => {
        captured = cmd
        return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }
      },
      runBackground: (cmd) => {
        captured = cmd
        return { jobId: "bash-1" }
      },
      getOutput: () => ({ id: "bash-1", status: "running", stdout: "", stderr: "" }),
      killJob: () => "already-finished",
      listJobs: () => [],
    }
    const [bash] = createShellTools({ exec: spyExec })
    await bash.execute({ command: "sleep 5", background: true }, { abortSignal: new AbortController().signal })
    expect(captured).toBeDefined()
    expect(captured!.abortSignal).toBeUndefined()
  })
})

describe("registerShell", () => {
  it("registers the exec service and both tools", () => {
    const ctx = createContext()
    const names: string[] = []
    registerShell(ctx, { register: (t) => names.push(t.name) })
    expect(names).toEqual(["bash", "pwsh"])
    expect(ctx.services.get("exec/service")).toBeDefined()
  })

  it("passes timeoutMs through to the registered tools", async () => {
    const ctx = createContext()
    const tools: Tool[] = []
    registerShell(ctx, { register: (t) => tools.push(t) }, { timeoutMs: 7000 })
    expect(tools.find((t) => t.name === "bash")?.timeoutMs).toBe(7000)
    expect(tools.find((t) => t.name === "pwsh")?.timeoutMs).toBe(7000)
  })
})

// Factory building a fake ExecService whose run() returns the given result
// (retention logic only needs exec.run to return { stdout, stderr, exitCode }).
function fakeExec(runResult: { stdout: string; stderr: string; exitCode: number }): ExecService {
  return {
    run: async () => ({ ...runResult, timedOut: false }),
    runBackground: () => ({ jobId: "none" }),
    getOutput: () => ({ id: "none", status: "completed", stdout: "", stderr: "", exitCode: 0 }),
    killJob: () => "already-finished",
    listJobs: () => [],
  }
}

describe("shell output retention", () => {
  it("bash truncates large stdout/stderr with the truncated marker", async () => {
    // fake exec.run returns a big stdout
    const big = "x".repeat(1000)
    const tools = createShellTools({ exec: fakeExec({ stdout: big, stderr: big, exitCode: 0 }), retention: { maxBytes: 100 } })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as { stdout: string; truncated?: { stdoutBytes: number; stderrBytes: number } }
    expect(res.stdout.length).toBeLessThanOrEqual(100)
    expect(res.truncated).toEqual({ stdoutBytes: 900, stderrBytes: 900 })
  })

  it("small output is unchanged (no truncated key)", async () => {
    const tools = createShellTools({ exec: fakeExec({ stdout: "hi", stderr: "", exitCode: 0 }), retention: { maxBytes: 100 } })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as { stdout: string; truncated?: unknown }
    expect(res.stdout).toBe("hi")
    expect(res.truncated).toBeUndefined()
  })

  it("no retention config → today's behavior (exact shape, no stderr)", async () => {
    const tools = createShellTools({ exec: fakeExec({ stdout: "hi", stderr: "err", exitCode: 0 }) })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as { stdout: string; exitCode: number }
    // Exactly today's shape: stderr is dropped entirely, no truncated marker.
    expect(res).toEqual({ stdout: "hi", exitCode: 0 })
  })

  it("pwsh also retains", async () => {
    const tools = createShellTools({ exec: fakeExec({ stdout: "y".repeat(500), stderr: "", exitCode: 0 }), retention: { maxBytes: 50 } })
    const pwsh = tools.find((t) => t.name === "pwsh")!
    const res = (await pwsh.execute({ command: "x" }, {} as never)) as { stdout: string; truncated?: { stdoutBytes: number } }
    expect(res.stdout.length).toBeLessThanOrEqual(50)
    expect(res.truncated).toBeDefined()
  })
})

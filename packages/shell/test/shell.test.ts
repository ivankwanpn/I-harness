import { describe, expect, it } from "vitest"
import { resolveShell, getArgv, createShellTools, registerShell } from "../src/index.ts"
import type { ExecService } from "@i-harness/exec"
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
  }

  it("returns bash and pwsh tools carrying getArgv (for guard-approval)", () => {
    const [bash, pwsh] = createShellTools({ exec: fakeExec })
    expect(bash.name).toBe("bash")
    expect(pwsh.name).toBe("pwsh")
    expect(bash.getArgv?.({ command: "rm -rf x" })).toEqual(["rm", "-rf", "x"])
    expect(pwsh.getArgv?.({ command: 'echo "hi there"' })).toEqual(["echo", "hi there"])
  })

  it("execute calls deps.exec.run with the resolved shell argv prefix", async () => {
    let captured: string[] = []
    const spyExec: ExecService = {
      run: async (cmd) => {
        captured = cmd.argv
        return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }
      },
    }
    const [bash] = createShellTools({ exec: spyExec })
    const result = (await bash.execute({ command: "echo hi" }, {})) as {
      stdout: string
      exitCode: number
    }
    expect(result.stdout).toBe("ok")
    expect(result.exitCode).toBe(0)
    const shell = resolveShell()
    expect(captured).toEqual([...shell.argv, "echo hi"])
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
})

import { describe, expect, it } from "vitest"
import { createExecService, type ExecService } from "../src/index.ts"
import { SandboxUnavailableError, type SandboxProvider, type SandboxPolicy } from "@i-harness/sandbox"

// Poll-wait helper: avoids raw fixed sleeps (flake-prone under parallel load).
async function waitForStatus(exec: ExecService, jobId: string, pred: (status: string) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = exec.getOutput(jobId).status
    if (pred(status)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for job ${jobId}`)
}

describe("exec service", () => {
  it("runs a command and captures stdout", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "console.log('hi')"] })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("hi")
    expect(result.timedOut).toBe(false)
  })

  it("captures exit codes and stderr", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "console.error('boom'); process.exit(3)"] })
    expect(result.exitCode).toBe(3)
    expect(result.stderr.trim()).toBe("boom")
  })

  it("times out long-running commands", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"], timeoutMs: 200 })
    expect(result.timedOut).toBe(true)
  }, 10_000)

  it("external abort kills a running command", async () => {
    const exec = createExecService()
    const controller = new AbortController()
    const started = Date.now()
    // run() spawns + registers the abort listener synchronously, so schedule
    // the abort right after and await the promise.
    const pending = exec.run({
      argv: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"],
      abortSignal: controller.signal,
    })
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(10_000)
    expect(result.exitCode).not.toBe(0)
    // An abort is NOT a timeout — callers must see the real exitCode.
    expect(result.timedOut).toBe(false)
  }, 10_000)

  it("aborts immediately when the signal is already aborted before spawn", async () => {
    const exec = createExecService()
    const controller = new AbortController()
    controller.abort()
    const result = await exec.run({
      argv: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"],
      abortSignal: controller.signal,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.timedOut).toBe(false)
  }, 10_000)

  it("writes stdin", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write('got:'+d))"], input: "x" })
    expect(result.stdout).toContain("got:x")
  })

  it("respects cwd", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "console.log(process.cwd())"], cwd: process.cwd() })
    expect(result.stdout.trim()).toBe(process.cwd())
  })
})

describe("exec background jobs", () => {
  it("runBackground returns immediately and accumulates output", async () => {
    const exec = createExecService()
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>console.log('done'), 100)"] })
    expect(jobId).toMatch(/^bash-\d+$/)
    expect(exec.getOutput(jobId).status).toBe("running")
    await waitForStatus(exec, jobId, (s) => s === "completed")
    const view = exec.getOutput(jobId)
    expect(view.status).toBe("completed")
    expect(view.stdout.trim()).toBe("done")
    expect(view.exitCode).toBe(0)
  }, 10_000)

  it("killJob cancels a running job and marks it killed", async () => {
    const exec = createExecService()
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"] })
    expect(exec.killJob(jobId)).toBe("cancellation-requested")
    await waitForStatus(exec, jobId, (s) => s === "killed")
    expect(exec.getOutput(jobId).status).toBe("killed")
    expect(exec.killJob(jobId)).toBe("already-finished")
  }, 10_000)

  it("getOutput for unknown job throws", () => {
    const exec = createExecService()
    expect(() => exec.getOutput("nope")).toThrow(/unknown job/i)
  })

  it("listJobs enumerates running and finished jobs", async () => {
    const exec = createExecService()
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 200)"] })
    const ids = exec.listJobs().map((j) => j.id)
    expect(ids).toContain(jobId)
    expect(exec.listJobs().find((j) => j.id === jobId)!.status).toBe("running")
    await waitForStatus(exec, jobId, (s) => s === "completed")
    expect(exec.listJobs().find((j) => j.id === jobId)!.status).toBe("completed")
  }, 10_000)

  it("getOutput shows accumulated stdout while the job is still running", async () => {
    const exec = createExecService()
    // 'late' is far enough out that the job is guaranteed still running when
    // the 'early' chunk becomes observable, even under parallel load.
    const { jobId } = exec.runBackground({ argv: [process.execPath, "-e", "console.log('early'); setTimeout(()=>console.log('late'), 1000)"] })
    await waitForStatus(exec, jobId, () => exec.getOutput(jobId).stdout.includes("early"))
    const view = exec.getOutput(jobId)
    expect(view.status).toBe("running")
    expect(view.stdout).toContain("early")
    await waitForStatus(exec, jobId, (s) => s === "completed")
    const done = exec.getOutput(jobId)
    expect(done.status).toBe("completed")
    expect(done.stdout).toContain("late")
  }, 10_000)
})

describe("exec sandbox", () => {
  const policy: SandboxPolicy = { mode: "read-only", workspaceRoot: "/" }

  it("confines argv when a provider AND a per-command policy exist", async () => {
    // Portable "confiner": re-exec the original argv under process.execPath. It
    // stands in for bwrap/ACL so the test runs on any host (incl. win32).
    const wrapper = "const{spawn}=require('node:child_process');const c=spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit'});c.on('error',()=>process.exit(1));c.on('exit',(code)=>process.exit(code??1));"
    const provider: SandboxProvider = {
      confine(argv, _policy) {
        return {
          argv: [process.execPath, "-e", wrapper, ...argv],
          enforcement: "full",
          denialSignatures: ["read-only file system"],
          runnerFailureRules: [],
        }
      },
    }
    const exec = createExecService({ sandbox: provider })
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('ok')"], sandbox: policy })
    expect(result.stdout).toBe("ok")
  })

  it("throws when cmd.sandbox is set but the service has no provider (fail-closed)", async () => {
    const exec = createExecService() // no provider
    await expect(exec.run({ argv: ["echo", "hi"], sandbox: policy })).rejects.toThrow(/no sandbox provider/)
  })

  it("runs unconfined when no policy (existing behavior)", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('plain')"] })
    expect(result.stdout).toBe("plain")
  })

  it("danger-full-access policy runs unconfined (passthrough)", async () => {
    const exec = createExecService() // no provider
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('full')"], sandbox: { mode: "danger-full-access", workspaceRoot: "/" } })
    expect(result.stdout).toBe("full")
  })

  it("runner failure (nonzero exit + fatal signature) → SandboxUnavailableError (I3)", async () => {
    // Simulates bwrap's exec-refusal shape: the runner exits 125 with
    // "bwrap: failed to ..." (user namespaces blocked). The provider confines
    // to `sh -c` with the exact stderr; exec must translate it to
    // SandboxUnavailableError instead of returning an ordinary failure.
    const provider: SandboxProvider = {
      confine(argv, _policy) {
        return {
          argv: [process.execPath, "-e", `console.error("bwrap: failed to create namespace: Permission denied"); process.exit(125)`, ...argv],
          enforcement: "full",
          denialSignatures: ["read-only file system"],
          runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ["bwrap: failed to"] }],
        }
      },
    }
    const exec = createExecService({ sandbox: provider })
    await expect(exec.run({ argv: ["echo", "hi"], sandbox: policy })).rejects.toThrow(SandboxUnavailableError)
    await expect(exec.run({ argv: ["echo", "hi"], sandbox: policy })).rejects.toThrow(/bwrap: failed to/)
  })

  it("nonzero exit WITHOUT a matching runner-failure rule stays an ordinary failure", async () => {
    const provider: SandboxProvider = {
      confine(argv, _policy) {
        // Exit 125 but no fatal signature → NOT a runner failure.
        return {
          argv: [process.execPath, "-e", "console.error('command body failed'); process.exit(125)", ...argv],
          enforcement: "full",
          denialSignatures: ["read-only file system"],
          runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ["bwrap: failed to"] }],
        }
      },
    }
    const exec = createExecService({ sandbox: provider })
    const result = await exec.run({ argv: ["echo", "hi"], sandbox: policy })
    expect(result.exitCode).toBe(125)
    expect(result.stderr).toContain("command body failed")
  })
})

import { describe, expect, it } from "vitest"
import { createExecService, type ExecService } from "../src/index.ts"

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

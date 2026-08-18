import { describe, expect, it } from "vitest"
import { createJobRegistry } from "../src/jobs.ts"

describe("job registry", () => {
  it("issues ids with per-kind monotonic counters", () => {
    const jobs = createJobRegistry()
    expect(jobs.registerJob("a", "bash", "build").id).toBe("bash-1")
    expect(jobs.registerJob("a", "subagent", "child").id).toBe("subagent-1")
    expect(jobs.registerJob("a", "bash", "test").id).toBe("bash-2")
  })

  it("read/list reflect updates; kill is terminal and blocks later updates", () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "build")
    jobs.updateJob(id, { output: "compiling..." })
    expect(jobs.read(id).output).toBe("compiling...")
    expect(jobs.list("a")).toHaveLength(1)
    expect(jobs.list("other")).toHaveLength(0)
    expect(jobs.kill(id)).toBe("cancellation-requested")
    jobs.updateJob(id, { status: "completed", output: "late" })
    expect(jobs.read(id).status).toBe("killed")
    expect(jobs.read(id).output).toBe("compiling...")
  })

  it("wait resolves on terminal status", async () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "build")
    let settled = false
    const p = jobs.wait(id, 2000).then(() => { settled = true })
    setTimeout(() => jobs.updateJob(id, { status: "completed" }), 20)
    await p
    expect(settled).toBe(true)
  })

  it("wait resolves on timeout without terminal status", async () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("a", "bash", "long")
    const started = Date.now()
    await jobs.wait(id, 50)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
    expect(jobs.read(id).status).toBe("running")
  })

  it("updateJob re-opens a terminal job when set to running again", () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("root", "subagent", "h")
    jobs.updateJob(id, { status: "completed", output: "done" })
    expect(jobs.read(id).status).toBe("completed")
    jobs.updateJob(id, { status: "running" })
    expect(jobs.read(id).status).toBe("running")
    jobs.updateJob(id, { status: "completed", output: "second" })
    expect(jobs.read(id).status).toBe("completed")
    expect(jobs.read(id).output).toBe("second")
  })
})

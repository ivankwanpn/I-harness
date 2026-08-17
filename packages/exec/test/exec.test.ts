import { describe, expect, it } from "vitest"
import { createExecService } from "../src/index.ts"

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

import { describe, expect, it } from "vitest"
import { createExecService } from "../src/index.ts"
import { readFileSync } from "node:fs"

describe("exec spill integration", () => {
  it("spills stdout when exceeding maxOutputBytes", async () => {
    // Same pattern as exec.test.ts: no sandbox, argv via process.execPath (works on win32).
    const exec = createExecService({ spill: { maxOutputBytes: 20 } })
    const r = await exec.run({ argv: [process.execPath, "-e", "console.log('x'.repeat(100))"] })
    expect(r.stdoutSpillPath).toBeDefined()
    expect(r.truncated?.stdout).toBe(true)
    // The spill file holds the full output (even the part outside the in-memory tail).
    const full = readFileSync(r.stdoutSpillPath!, "utf-8")
    expect(full).toContain("x".repeat(100))
  }, 10_000)

  it("no spill under limit", async () => {
    const exec = createExecService({ spill: { maxOutputBytes: 64_000 } })
    const r = await exec.run({ argv: [process.execPath, "-e", "console.log('hi')"] })
    expect(r.stdoutSpillPath).toBeUndefined()
    expect(r.truncated).toBeUndefined()
  }, 10_000)
})

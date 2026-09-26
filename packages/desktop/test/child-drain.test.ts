import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { drainChildStream } from "../src/main/sdk-runtime.ts"

describe("child stream drain", () => {
  it("keeps a child alive when it floods stderr past the pipe buffer", async () => {
    const child = spawn(process.execPath, ["-e", "process.stderr.write('x'.repeat(300000)); process.exit(0)"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    })
    drainChildStream(child.stderr)
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve))
    expect(code).toBe(0)
  }, 20_000)
})

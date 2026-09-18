import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"

// M3's metrics registry, WIRED. The reachability gate is the reason this test
// exists at all: `createMetricsSink` landed with no production consumer and the
// instrument said so — two NEW rows the moment it was exported. **Wiring a reader
// is the fix; an allowlist entry would have been the pattern this repo keeps
// deleting.**
//
// So this pins the reader, not the counter (the counter has its own file):
// a run that asked for observability reports the summary, and one that did not
// stays quiet.

describe("runHeadless — the metrics summary", () => {
  let root: string
  const errors: string[] = []
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i-harness-metrics-"))
    errors.length = 0
    spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")) })
  })
  afterEach(() => {
    spy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it("a run with telemetry ON reports the summary on STDERR", async () => {
    const result = await runHeadless("say hi", {
      workspace: root,
      telemetry: "jsonl",
      mockScript: [{ role: "assistant", text: "hi" }],
    })
    expect(result.exitCode).toBe(0)
    const summary = errors.find((line) => line.includes("[metrics]"))
    expect(summary).toBeDefined()
    // The run's own events, counted — not an empty summary that would also pass
    // a `toContain("[metrics]")` assertion.
    expect(summary).toMatch(/turn\/start=1/)
  }, 30_000)

  it("a run with telemetry OFF stays quiet — the summary is for the operator who asked", async () => {
    await runHeadless("say hi", {
      workspace: root,
      mockScript: [{ role: "assistant", text: "hi" }],
    })
    expect(errors.some((line) => line.includes("[metrics]"))).toBe(false)
  }, 30_000)
})

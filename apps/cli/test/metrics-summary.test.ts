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

  // M5 T2. The reader for the provider's OWN numbers. Without it, `reported`
  // would be an accumulator with a producer and no consumer — the shape the
  // instrument flags and this repo deletes — and the completion definition
  // ("快取連續性可從 provider 回報…觀察") would have no observable at all.
  //
  // The event COUNT is asserted alongside the values on purpose: it is the
  // denominator that makes `cacheReadTokens=0` mean "the provider said zero"
  // rather than "nobody ever reported".
  it("M5 T2: reports what the PROVIDER said, in its own section, with its count", async () => {
    await runHeadless("say hi", {
      workspace: root,
      telemetry: "jsonl",
      mockScript: [{ role: "assistant", text: "hi", usage: { inputTokens: 12, cacheReadTokens: 400 } }],
    })
    const summary = errors.find((line) => line.includes("[metrics]"))
    expect(summary).toBeDefined()
    expect(summary).toMatch(/provider\/usage=1/)
    expect(summary).toMatch(/reported: [^\n]*cacheReadTokens=400/)
    // Our estimate keeps its own section — the two facts are never merged.
    expect(summary).toMatch(/tokens: tokens=/)
  }, 30_000)

  // M5 T2, second half. Same discipline as the section above: the number is
  // printed WITH its denominator, so "no comparison happened" stays readable
  // apart from "the prefix held".
  it("M5 T2: reports the measured prefix with its denominator", async () => {
    await runHeadless("say hi", {
      workspace: root,
      telemetry: "jsonl",
      approveAll: true,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "write", args: { path: "note.txt", text: "hello" } }] },
        { role: "assistant", text: "done" },
      ],
    })
    const summary = errors.find((line) => line.includes("[metrics]"))
    expect(summary).toBeDefined()
    // Two requests, both sent by this process — and the denominator is 1, not 2:
    // the process's FIRST request had nothing to compare against, so it is
    // neither kept nor broke. A pure append is not a break.
    expect(summary).toMatch(/prefix\(broke\/observed\): 0\/1/)
  }, 30_000)

  it("M5 T2: a run whose only request is the process's first compares nothing — 0/0", async () => {
    await runHeadless("say hi", {
      workspace: root,
      telemetry: "jsonl",
      mockScript: [{ role: "assistant", text: "hi" }],
    })
    const summary = errors.find((line) => line.includes("[metrics]"))
    expect(summary).toBeDefined()
    // The denominator is printed even when it is zero: `0/0` says out loud that
    // nothing was compared, where a bare `0` would read as a measurement.
    expect(summary).toMatch(/prefix\(broke\/observed\): 0\/0/)
  }, 30_000)
})

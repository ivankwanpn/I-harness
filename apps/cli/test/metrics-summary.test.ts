import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"
import { main } from "../src/index.ts"

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

  // M72 II: the run-level end of the truncation chain. The seam bit (Task 6)
  // and the durable field are separate hops; this is the one that proves the
  // VALUE arrives at the host's `run` — and it is the only end-to-end proof,
  // since the three middle hops have no unit test of their own.
  it("M72 Ⅱ: a truncated run says so on STDERR and on the result", async () => {
    const result = await runHeadless("say hi", {
      workspace: root,
      mockScript: [{ role: "assistant", text: "partial", truncated: true }],
    })
    expect(result.truncated).toBe(true)
    expect(errors.some((line) => line.includes("[truncated]"))).toBe(true)
  }, 30_000)

  it("M72 Ⅱ: a clean run neither says it nor sets the field", async () => {
    const result = await runHeadless("say hi", { workspace: root, mockScript: [{ role: "assistant", text: "hi" }] })
    expect(result.truncated).toBeUndefined()
    expect(errors.some((line) => line.includes("[truncated]"))).toBe(false)
  }, 30_000)

  // M72 Ⅱ / R14: ONE print, not two. The count is asserted END-TO-END, through
  // `main()`'s run branch — the only level where both print sites were
  // reachable at once (run.ts's and index.ts's), which is exactly the
  // duplication R14 removed. A runHeadless-only test could never have seen it:
  // that function has always printed once.
  //
  // The fixture is cli.test.ts's shape — a local SSE server plus an
  // IH_CONFIG_DIR whose `llm.defaultModel` points at it — so the round-trip
  // really crosses the adapter (`finish_reason: "length"` is what Task 6 taught
  // llm-openai-compatible to read) instead of a mock client.
  it("M72 Ⅱ: a truncated run through the real CLI says it EXACTLY once", async () => {
    const home = mkdtempSync(join(tmpdir(), "i-harness-truncated-"))
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("truncation fixture failed to listen")
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      llm: {
        providers: {
          fixture: {
            protocol: "openai-completions",
            baseURL: `http://127.0.0.1:${address.port}`,
            apiKeyEnv: "M72_TRUNCATED_FIXTURE_API_KEY",
            models: [{ id: "fixture-model" }],
          },
        },
        defaultModel: { provider: "fixture", model: "fixture-model" },
      },
    }), "utf8")
    writeFileSync(join(home, "credentials.json"), JSON.stringify({ refs: { M72_TRUNCATED_FIXTURE_API_KEY: "fixture-key" } }), "utf8")
    const previousConfigDir = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
    const out = vi.spyOn(console, "log").mockImplementation(() => {}) // the final text is not this test's subject
    try {
      const code = await main(["node", "i-harness", "run", "say hi"])
      expect(code).toBe(0)
      // The assertion R14 buys: one line, whatever route the host took.
      expect(errors.filter((line) => line.includes("[truncated]"))).toHaveLength(1)
    } finally {
      out.mockRestore()
      if (previousConfigDir === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = previousConfigDir
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  // R14 confirmation (ii), measured rather than argued: with telemetry ON the
  // summary line itself carries the new event row — the sink counts whatever
  // arrives by type, so a cap-hitting round-trip is visible there too.
  it("M72 Ⅱ: the metrics summary counts the cap-hitting round-trip", async () => {
    await runHeadless("say hi", {
      workspace: root,
      telemetry: "jsonl",
      mockScript: [{ role: "assistant", text: "partial", truncated: true }],
    })
    const summary = errors.find((line) => line.includes("[metrics]"))
    expect(summary).toBeDefined()
    expect(summary).toMatch(/provider\/truncated=1/)
  }, 30_000)
})

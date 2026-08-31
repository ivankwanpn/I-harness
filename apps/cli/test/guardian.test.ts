import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"
import { createMockClient } from "@i-harness/llm-mock"

describe("CLI guardian", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-guard-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("denying reviewer fails the turn closed with the rationale", async () => {
    // `write` to a path OUTSIDE the workspace triggers the approval classifier
    // ("write target outside workspace requires approval" → ask branch fires,
    // the guardian is consulted before completion). The agent's tool call
    // therefore never executes; a second script step would leave the mock with
    // an unused step (harmless).
    const parentModel = createMockClient([
      { role: "assistant", toolCalls: [{ name: "write", args: { path: join(dir, "..", "outside.txt"), content: "x" } }] },
    ])
    const reviewerModel = createMockClient([
      { role: "assistant", text: '{"outcome":"deny","rationale":"writes are denied today","risk_level":"moderate"}' },
    ])
    const result = await runHeadless("write the file", {
      workspace: dir,
      model: parentModel,
      guardian: { model: reviewerModel },
    })
    expect(result.exitCode).toBe(1)
    expect(result.error).toMatch(/guardian denied: writes are denied today/)
  })

  it("is inert when guardian is not configured", async () => {
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const result = await runHeadless("hello", { workspace: dir, model })
    expect(result.exitCode).toBe(0)
  })
})

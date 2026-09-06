// apps/tui — the tui command is thin wiring; this test pins the flag parser
// so the CLI surface cannot drift silently (the PTY proofs of the render
// pipeline live in packages/tui/test/harness — cases 011/014).

import { describe, expect, it } from "vitest"
import {
  buildEmbeddedSessionOptions,
  buildSdkArgs,
  createTuiModelBindingFor,
  createTuiShutdownController,
  parseFlags,
} from "../src/index.ts"

describe("tui flag parser", () => {
  it("adapts provider runtime clients into session-executor model bindings", async () => {
    const client = { async *stream() { yield { type: "end" as const } } }
    const seen: unknown[] = []
    const bindingFor = createTuiModelBindingFor({
      async resolveModel(input: unknown) {
        seen.push(input)
        return {
          status: "ready" as const,
          binding: {
            client,
            providerId: "fixture",
            modelId: "flag-model",
            label: "fixture:flag-model",
            reasoningEffort: "high" as const,
            contextWindow: 128_000,
          },
        }
      },
    }, "fixture:flag-model")

    await expect(bindingFor("s1", {
      modelSelection: { provider: "session", model: "selected" },
    } as never)).resolves.toEqual({
      status: "ready",
      binding: {
        model: client,
        providerId: "fixture",
        modelId: "flag-model",
        label: "fixture:flag-model",
        reasoningEffort: "high",
        contextWindow: 128_000,
      },
    })
    expect(seen).toEqual([{
      sessionSelection: { provider: "session", model: "selected" },
      override: "fixture:flag-model",
    }])
  })

  it("parses value flags in any order plus the boolean --yes", () => {
    expect(
      parseFlags(["--prompt", "hi there", "--workspace", "C:\\w", "--model", "deepseek:deepseek-chat", "--yes", "--session-dir", "C:\\sessions", "--resume", "s-123"]),
    ).toEqual({
      prompt: "hi there",
      workspace: "C:\\w",
      model: "deepseek:deepseek-chat",
      yes: true,
      sessionDir: "C:\\sessions",
      resume: "s-123",
    })
  })

  it("builds durable resume options without an initial kickoff", () => {
    expect(buildEmbeddedSessionOptions({ sessionDir: "C:\\sessions", resume: "s-123", prompt: "kickoff" })).toEqual({ prompt: "", storeRoot: "C:\\sessions", rewindStoreRoot: "C:\\sessions", resumeSessionId: "s-123" })
  })

  it("rejects resume without a durable session directory", () => {
    expect(() => buildEmbeddedSessionOptions({ resume: "s-123", prompt: "" })).toThrow(
      "--resume requires --session-dir",
    )
  })

  it("passes the durable root to the attached SDK and preserves ephemeral attach args", () => {
    expect(buildSdkArgs({ sessionDir: "C:\\sessions" })).toEqual(["sdk", "--session-dir", "C:\\sessions"])
    expect(buildSdkArgs({ sessionDir: undefined })).toEqual(["sdk"])
  })

  it("awaits backend close before teardown and shares concurrent shutdowns", async () => {
    const events: string[] = []
    let release!: () => void
    const close = () => new Promise<void>(resolve => { events.push("close-start"); release = () => { events.push("close-end"); resolve() } })
    const controller = createTuiShutdownController({ close, stop: () => events.push("stop"), teardown: () => events.push("teardown") })
    const first = controller.shutdown()
    const second = controller.shutdown()
    expect(first).toBe(second)
    await Promise.resolve()
    expect(events).toEqual(["stop", "close-start"])
    release()
    await first
    expect(events).toEqual(["stop", "close-start", "close-end", "teardown"])
  })

  it("attempts teardown and preserves close failures", async () => {
    const events: string[] = []
    const failure = new Error("flush failed")
    const controller = createTuiShutdownController({
      close: async () => { events.push("close"); throw failure },
      stop: () => events.push("stop"),
      teardown: () => events.push("teardown"),
    })

    await expect(controller.shutdown()).rejects.toBe(failure)
    expect(events).toEqual(["stop", "close", "teardown"])
  })

  it("treats every flag as optional and unknown flags as no-ops", () => {
    expect(parseFlags([])).toEqual({ yes: false })
    expect(parseFlags(["--unknown"])).toEqual({ yes: false })
  })
})

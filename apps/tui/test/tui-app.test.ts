// apps/tui — the tui command is thin wiring; this test pins the flag parser
// so the CLI surface cannot drift silently (the PTY proofs of the render
// pipeline live in packages/tui/test/harness — cases 011/014).

import { describe, expect, it } from "vitest"
import { buildEmbeddedSessionOptions, buildSdkArgs, createTuiShutdownController, parseFlags } from "../src/index.ts"

describe("tui flag parser", () => {
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

  it("treats every flag as optional and unknown flags as no-ops", () => {
    expect(parseFlags([])).toEqual({ yes: false })
    expect(parseFlags(["--unknown"])).toEqual({ yes: false })
  })
})

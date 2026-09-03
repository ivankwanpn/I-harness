// apps/tui — the tui command is thin wiring; this test pins the flag parser
// so the CLI surface cannot drift silently (the PTY proofs of the render
// pipeline live in packages/tui/test/harness — cases 011/014).

import { describe, expect, it } from "vitest"
import { parseFlags } from "../src/index.ts"

describe("tui flag parser", () => {
  it("parses value flags in any order plus the boolean --yes", () => {
    expect(
      parseFlags(["--prompt", "hi there", "--workspace", "C:\\w", "--model", "deepseek:deepseek-chat", "--yes", "--resume", "s-123"]),
    ).toEqual({
      prompt: "hi there",
      workspace: "C:\\w",
      model: "deepseek:deepseek-chat",
      yes: true,
      resume: "s-123",
    })
  })

  it("treats every flag as optional and unknown flags as no-ops", () => {
    expect(parseFlags([])).toEqual({ yes: false })
    expect(parseFlags(["--unknown"])).toEqual({ yes: false })
  })
})

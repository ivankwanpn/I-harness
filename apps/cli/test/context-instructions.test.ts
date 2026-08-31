import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import type { SessionEvent } from "@i-harness/core-session"

describe("CLI runtime context + instructions", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-ctx-"))
    writeFileSync(join(dir, "AGENTS.md"), "Use pnpm only. Never touch the vendor dir.")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("renders the instructions section into the first snapshot, model-visible", async () => {
    const session = createSession()
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const result = await runHeadless("task", { workspace: dir, model, session })
    expect(result.exitCode).toBe(0)
    const snapshots = session.events.filter(
      (e): e is Extract<SessionEvent, { type: "user/message" }> =>
        e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === "i-harness/runtime-context",
    )
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.text).toContain("Use pnpm only")
    expect(snapshots[0]!.text).toContain("## instructions")
  })
})

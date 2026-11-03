import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"
import { createSession, renderRuntimeContext } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import type { SessionEvent } from "@i-harness/core-session"
import type { LLMRequest } from "@i-harness/llm-seam"
import { createRuntimeContext } from "../../../packages/runtime-context/src/index.ts"

describe("CLI runtime context + instructions", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-ctx-"))
    writeFileSync(join(dir, "AGENTS.md"), "Use pnpm only. Never touch the vendor dir.")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("publishes typed current instructions and sends only the latest prefix to the model", async () => {
    const session = createSession()
    const previous = createRuntimeContext(session)
    previous.registerSection("instructions", () => "RETIRED_INSTRUCTIONS_SENTINEL")
    await previous.render(); await previous.close()
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const requests: LLMRequest[] = [], prepare = model.prepare!.bind(model)
    const preparing = vi.spyOn(model as typeof model & { prepare: NonNullable<typeof model.prepare> }, "prepare").mockImplementation(async (request: LLMRequest) => { requests.push(request); return prepare(request) })
    const result = await runHeadless("task", { workspace: dir, model, session })
    preparing.mockRestore()
    expect(result.exitCode).toBe(0)
    const snapshots = session.events.filter(
      (e): e is Extract<SessionEvent, { type: "runtime/context" }> => e.type === "runtime/context",
    )
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]!.sections).toEqual([{ name: "instructions", text: "RETIRED_INSTRUCTIONS_SENTINEL" }])
    expect(snapshots[1]!.version).toBe(1)
    expect(renderRuntimeContext(snapshots[1]!.sections)).toContain("## instructions")
    expect(snapshots[1]!.sections.find(section => section.name === "instructions")?.text).toContain("Use pnpm only. Never touch the vendor dir.")
    expect(JSON.stringify(requests[0]!.messages).split("Use pnpm only. Never touch the vendor dir.")).toHaveLength(2)
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("RETIRED_INSTRUCTIONS_SENTINEL")
    expect(session.events.filter(event => event.type === "user/message" && event.source?.kind === "plugin" && event.source.plugin === "i-harness/runtime-context")).toHaveLength(0)
  })

  it("W11: forwards subagentStaleAfterMs to the assembly (the option reaches the knob it names)", async () => {
    // The section's BEHAVIOUR is pinned at the assembly level
    // (packages/session-executor/test/subagent-stale-section.test.ts). What is
    // pinned here is the ROUTING, and deliberately through a value whose effect
    // is observable without a subagent: a threshold the assembly's own warning
    // names. A CLI option that is parsed and never reaches the consumer reads
    // exactly like a wired one to every scanner in scripts/audit, so this line
    // is what tells them apart.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const session = createSession()
      const result = await runHeadless("task", {
        workspace: dir,
        model: createMockClient([{ role: "assistant", text: "ok" }]),
        session,
        subagentStaleAfterMs: 0,
      })
      expect(result.exitCode).toBe(0)
      expect(warn.mock.calls.map(([m]) => String(m)).some((m) => m.includes("subagentStaleAfterMs"))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

import { describe, expect, it, vi } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { registerCommand, runCommand } from "@i-harness/interaction"
import { createSessionAssembly } from "@i-harness/session-executor"
import type { CompactionResult } from "@i-harness/compaction"
import { handleSessionCompactCommand } from "../src/run.ts"

// M33 §5: manual compact surface — session-compact command (v0 error texts +
// JSON echo; busy when the executor lane is running).
const noopMaybe = async (): Promise<CompactionResult> => ({ compacted: false, shadowedSeqs: [] })

function deps(overrides: Partial<{ compactNow: (instructions?: string) => Promise<CompactionResult>; isRunning: () => boolean }> = {}) {
  const compactNow = vi.fn(async (instructions?: string): Promise<CompactionResult> => ({
    compacted: true,
    shadowedSeqs: [0, 1],
    ...(instructions !== undefined ? { summary: `summarized (${instructions})` } : { summary: "summarized" }),
  }))
  return {
    compactNow,
    isRunning: () => false,
    ...overrides,
  }
}

describe("session-compact command (M33 §5)", () => {
  it("executes compactNow and echoes the JSON result", async () => {
    const d = deps()
    const out = await handleSessionCompactCommand(d, "{}")
    expect(d.compactNow).toHaveBeenCalledWith(undefined)
    expect(JSON.parse(out)).toEqual({ compacted: true, shadowedSeqs: [0, 1], summary: "summarized" })
  })

  it("threads instructions to compactNow and echoes summary", async () => {
    const d = deps()
    const out = await handleSessionCompactCommand(d, JSON.stringify({ instructions: "keep X" }))
    expect(d.compactNow).toHaveBeenCalledWith("keep X")
    expect(JSON.parse(out).summary).toBe("summarized (keep X)")
  })

  it("is busy while the agent run is in flight", async () => {
    const d = deps({ isRunning: () => true })
    const out = await handleSessionCompactCommand(d, "{}")
    expect(out).toContain("busy")
    expect(d.compactNow).not.toHaveBeenCalled()
  })

  it("reports 'No compactable history yet.' when nothing is compactable", async () => {
    const d = deps({ compactNow: noopMaybe })
    expect(await handleSessionCompactCommand(d, "{}")).toBe("No compactable history yet.")
  })

  it("rejects a non-string instructions payload", async () => {
    const d = deps()
    await expect(handleSessionCompactCommand(d, JSON.stringify({ instructions: 42 }))).rejects.toThrow(/instructions/)
    expect(d.compactNow).not.toHaveBeenCalled()
  })

  it("registers and runs through the real command registry", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "initial work" })
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session: s,
      model: createMockClient([{ role: "assistant", text: "ok" }]),
      compact: { contextWindow: 100_000 },
    })
    try {
      registerCommand(assembly.ctx, {
        name: "session-compact",
        description: "compact the session now",
        argumentHints: "{ instructions?: string }",
        execute: (input) => handleSessionCompactCommand(
          { compactNow: (i) => assembly.compactNow(i), isRunning: () => false },
          input,
        ),
      })
      const out = await runCommand(assembly.ctx, "session-compact", "{}")
      const parsed = JSON.parse(out) as { compacted: boolean; shadowedSeqs: number[]; summary: string }
      expect(parsed.compacted).toBe(true)
      expect(parsed.shadowedSeqs).toEqual([0])
      expect(parsed.summary).toBeDefined()
      expect(assembly.session.events.some((e) => e.type === "compaction/summary")).toBe(true)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})

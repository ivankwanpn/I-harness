// packages/compaction/test/site-diagnostics.test.ts — R15: the captured INSTANCE
// net over this package's real diagnostics site.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// Covered: `src/index.ts:16`'s ambient handle (`diagnosticsFor("turn")`), driven
// through the real `CompactionEngine.compact` fail-soft arm (index.ts:169).
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import {
  createDiagnostics,
  currentDiagnostics,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "@i-harness/diagnostics"
import { createCompactionEngine, type CompactionConfig } from "../src/index.ts"

/** The identity redactor: these cases are about the ROUTING (phase/level), and
 *  the real scans are their own task. */
const passthrough: Redactor = {
  redact: (value) => value,
  registerSecret: () => {},
  size: () => ({ rules: 0, secrets: 0 }),
}

function captureStream(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = []
  const stream = { write: (s: string) => { lines.push(s); return true } } as unknown as NodeJS.WritableStream
  return { stream, lines }
}

function parsed(lines: string[]): DiagnosticRecord[] {
  return lines.map((l) => JSON.parse(l) as DiagnosticRecord)
}

/** `engine.test.ts`'s config + long-session fixture, unchanged. */
const config: CompactionConfig = { contextWindow: 1000, thresholdRatio: 0.5, maxTokens: 50 }

function longSession() {
  const s = createSession()
  for (let i = 0; i < 20; i++) append(s, { type: "user/message", text: "word ".repeat(80) })
  return s
}

const ENV = "I_HARNESS_LOG"

beforeEach(() => { delete process.env[ENV] })

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[ENV]
  currentDiagnostics()?.close()
})

it("the summarizer's fail-soft report is the ambient handle's, at phase turn / level warn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const failing: ModelClient = {
    async *stream(): AsyncIterable<LLMStreamEvent> {
      yield { type: "error", error: new Error("model exploded") }
    },
  }
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

  const engine = createCompactionEngine({ model: failing, config })
  const result = await engine.compact(longSession())

  expect(result).toEqual({ compacted: false, shadowedSeqs: [] })
  expect(lines).toHaveLength(1)
  expect(parsed(lines)[0]).toMatchObject({ phase: "turn", level: "warn", run: "r15" })
  expect(parsed(lines)[0]!.msg).toContain("compaction summarizer failed (fail-soft, retrying next step): model exploded")
  expect(warn).not.toHaveBeenCalled()
})

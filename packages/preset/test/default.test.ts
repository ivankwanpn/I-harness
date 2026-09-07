// M49 Task 14 (spec §11): the I-harness-owned DEFAULT_AGENT_PRESET —
// parseable, readable in source, no copied Grok wording, covers the base
// contract (repository-first, tools/approval/sandbox honesty, systematic
// debugging, test-first, verification, subagent ownership, progress, honest
// capability reporting, concise final delivery).

import { describe, expect, it } from "vitest"
import { DEFAULT_AGENT_PRESET } from "../src/default.ts"
import { parsePreset } from "../src/index.ts"

describe("DEFAULT_AGENT_PRESET", () => {
  it("is a complete, parseable AgentPreset (name/systemPrompt/tools)", () => {
    const parsed = parsePreset(JSON.stringify(DEFAULT_AGENT_PRESET))
    expect(parsed.name).toBe(DEFAULT_AGENT_PRESET.name)
    expect(parsed.systemPrompt.length).toBeGreaterThan(200)
    expect(Array.isArray(parsed.tools)).toBe(true)
    expect(DEFAULT_AGENT_PRESET.tools.length).toBeGreaterThan(0)
  })

  it("covers the spec §11 base contract verbatim keywords", () => {
    const p = DEFAULT_AGENT_PRESET.systemPrompt
    // identity + repository-first minimal-change discipline
    expect(p).toContain("I-harness")
    expect(p).toContain("repository")
    expect(p).toContain("existing patterns")
    // tool/approval/sandbox semantics — never a pretended action
    expect(p).toContain("approval")
    expect(p).toContain("sandbox")
    expect(p).toContain("only actions that actually ran")
    // systematic debugging + test-first + verification
    expect(p).toContain("root cause")
    expect(p).toContain("failing test first")
    expect(p).toContain("verify before claiming completion")
    // subagent scope/ownership/result integration + progress + delivery
    expect(p).toContain("subagent")
    expect(p).toContain("progress")
    expect(p).toContain("what is not done")
    // honest capability reporting
    expect(p).toContain("not be presented as real capability")
  })

  it("is I-harness-owned: no Grok/xAI wording, honest identity, no obfuscation", () => {
    const p = DEFAULT_AGENT_PRESET.systemPrompt
    expect(p).not.toContain("Grok")
    expect(p).not.toContain("xAI")
    // identity: a local agent that claims no hosted/account capability
    expect(p).toContain("local coding agent")
    expect(p).toContain("claim no hosted")
  })
})

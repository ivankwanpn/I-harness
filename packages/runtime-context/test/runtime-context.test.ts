import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, createNondurableFactOwner, deriveMessages, type SessionEvent } from "@i-harness/core-session"
import { createRuntimeContext, installRuntimeContext, RUNTIME_CONTEXT_SOURCE_PLUGIN } from "../src/index.ts"

function snapshotTexts(s: ReturnType<typeof createSession>): string[] {
  return s.events.filter(
    (e): e is Extract<SessionEvent, { type: "user/message" }> =>
      e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === RUNTIME_CONTEXT_SOURCE_PLUGIN,
  ).map((e) => e.text)
}

describe("runtime context", async () => {
  it("appends a snapshot only when the rendered text changed", async () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("cwd", () => "/workspace/app")
    rc.registerSection("git", () => "branch: main")
    await rc.render()
    await rc.render()
    expect(snapshotTexts(s)).toHaveLength(1)
    rc.currentText()
    expect(snapshotTexts(s)[0]!).toContain("## cwd")
    expect(snapshotTexts(s)[0]!).toContain("/workspace/app")
    expect(snapshotTexts(s)[0]!).toContain("branch: main")
  })

  it("writes the cleared marker when the last section empties", async () => {
    const s = createSession()
    let branch = "main"
    const rc = createRuntimeContext(s)
    rc.registerSection("git", () => branch)
    await rc.render()
    branch = ""
    await rc.render()
    expect(snapshotTexts(s)).toHaveLength(2)
    expect(snapshotTexts(s)[1]!).toContain("none")
  })

  it("keeps different overlapping snapshots in source order without merging a later return to earlier text", async () => {
    const s = createSession(), rc = createRuntimeContext(s)
    let text = 'first'
    rc.registerSection('state', () => text)
    const first = rc.render()
    text = 'second'
    const second = rc.render()
    text = 'first'
    const third = rc.render()
    await Promise.all([first, second, third])
    expect(snapshotTexts(s)).toEqual(['## state\n\nfirst', '## state\n\nsecond', '## state\n\nfirst'])
  })

  it("does not advance the retained snapshot after a refused admission", async () => {
    const s = createSession(), feedback = createNondurableFactOwner(s).beginAction().facts.agent
    let attempts = 0
    const rc = createRuntimeContext(s, { feedback(event) {
      attempts++
      return attempts === 1 ? Promise.resolve({ kind: 'not-issued', code: 'FACT_CANCELLED' }) : feedback.feedback(event)
    } })
    rc.registerSection('state', () => 'same text')
    await expect(rc.render()).rejects.toMatchObject({ code: 'FACT_CANCELLED' })
    expect(snapshotTexts(s)).toEqual([])
    await rc.render()
    await rc.render()
    expect(attempts).toBe(2)
    expect(snapshotTexts(s)).toEqual(['## state\n\nsame text'])
  })

  it("does not share an identical pending snapshot across different actual feedback ports", async () => {
    const s = createSession(), feedback = createNondurableFactOwner(s).beginAction().facts.agent
    const release = Promise.withResolvers<void>()
    let resolutions = 0
    const first = { async feedback(event: Parameters<typeof feedback.feedback>[0]) { await release.promise; return feedback.feedback(event) } }
    const refused = { async feedback() { return { kind: 'not-issued' as const, code: 'FACT_CANCELLED' as const } } }
    const rc = createRuntimeContext(s, () => ++resolutions === 1 ? first : refused)
    rc.registerSection('state', () => 'same text')
    const held = rc.render()
    try {
      await expect(rc.render()).rejects.toMatchObject({ code: 'FACT_CANCELLED' })
      expect(snapshotTexts(s)).toEqual([])
    } finally { release.resolve(); await held }
    expect(resolutions).toBe(2)
    expect(snapshotTexts(s)).toEqual(['## state\n\nsame text'])
  })

  it("keeps a newer confirmed snapshot when an older admission fails later", async () => {
    const s = createSession(), feedback = createNondurableFactOwner(s).beginAction().facts.agent
    const release = Promise.withResolvers<void>()
    let resolutions = 0, text = 'old'
    const lateFailure = { async feedback() { await release.promise; return { kind: 'not-issued' as const, code: 'FACT_CANCELLED' as const } } }
    const rc = createRuntimeContext(s, () => ++resolutions === 1 ? lateFailure : feedback)
    rc.registerSection('state', () => text)
    const old = rc.render()
    text = 'new'
    await rc.render()
    release.resolve()
    await expect(old).rejects.toMatchObject({ code: 'FACT_CANCELLED' })
    await rc.render()
    expect(resolutions).toBe(2)
    expect(snapshotTexts(s)).toEqual(['## state\n\nnew'])
  })

  it("recreates the retained snapshot from the log (replay)", async () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("s", () => "v1")
    await rc.render()
    await rc.render()
    const again = createRuntimeContext(s)
    const section = { name: "s", getter: () => "v1" }
    const before = s.events.length
    again.registerSection(section.name, section.getter)
    await again.render() // same text → no new snapshot
    expect(s.events.length).toBe(before)
  })

  it("snapshots are model-visible user messages", async () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("state", () => "on branch feature")
    await rc.render()
    const msgs = deriveMessages(s)
    expect(msgs.some((m) => m.role === "user" && m.content === "## state\n\non branch feature")).toBe(true)
  })

  it("installRuntimeContext renders on the agent/pre-step emit (loop integration seam)", async () => {
    const ctx = createContext()
    const s = createSession()
    const rc = installRuntimeContext(ctx, s)
    rc.registerSection("cwd", () => "/w")
    await ctx.emit("agent/pre-step", { task: "t", session: s })
    expect(snapshotTexts(s)).toHaveLength(1)
    await ctx.emit("agent/pre-step", { task: "t", session: s })
    expect(snapshotTexts(s)).toHaveLength(1) // unchanged → no second snapshot
  })
})

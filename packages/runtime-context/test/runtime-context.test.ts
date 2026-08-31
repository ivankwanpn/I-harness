import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveMessages, type SessionEvent } from "@i-harness/core-session"
import { createRuntimeContext, installRuntimeContext, RUNTIME_CONTEXT_SOURCE_PLUGIN } from "../src/index.ts"

function snapshotTexts(s: ReturnType<typeof createSession>): string[] {
  return s.events.filter(
    (e): e is Extract<SessionEvent, { type: "user/message" }> =>
      e.type === "user/message" && e.source?.kind === "plugin" && e.source.plugin === RUNTIME_CONTEXT_SOURCE_PLUGIN,
  ).map((e) => e.text)
}

describe("runtime context", () => {
  it("appends a snapshot only when the rendered text changed", () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("cwd", () => "/workspace/app")
    rc.registerSection("git", () => "branch: main")
    rc.render()
    rc.render()
    expect(snapshotTexts(s)).toHaveLength(1)
    rc.currentText()
    expect(snapshotTexts(s)[0]!).toContain("## cwd")
    expect(snapshotTexts(s)[0]!).toContain("/workspace/app")
    expect(snapshotTexts(s)[0]!).toContain("branch: main")
  })

  it("writes the cleared marker when the last section empties", () => {
    const s = createSession()
    let branch = "main"
    const rc = createRuntimeContext(s)
    rc.registerSection("git", () => branch)
    rc.render()
    branch = ""
    rc.render()
    expect(snapshotTexts(s)).toHaveLength(2)
    expect(snapshotTexts(s)[1]!).toContain("none")
  })

  it("recreates the retained snapshot from the log (replay)", () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("s", () => "v1")
    rc.render()
    rc.render()
    const again = createRuntimeContext(s)
    const section = { name: "s", getter: () => "v1" }
    const before = s.events.length
    again.registerSection(section.name, section.getter)
    again.render() // same text → no new snapshot
    expect(s.events.length).toBe(before)
  })

  it("snapshots are model-visible user messages", async () => {
    const s = createSession()
    const rc = createRuntimeContext(s)
    rc.registerSection("state", () => "on branch feature")
    rc.render()
    const msgs = deriveMessages(s)
    expect(msgs.some((m) => m.role === "user" && m.content === "## state\n\non branch feature")).toBe(true)
  })

  it("installRuntimeContext renders on the agent/pre-step emit (loop integration seam)", () => {
    const ctx = createContext()
    const s = createSession()
    const rc = installRuntimeContext(ctx, s)
    rc.registerSection("cwd", () => "/w")
    void ctx.emit("agent/pre-step", { task: "t", session: s })
    expect(snapshotTexts(s)).toHaveLength(1)
    void ctx.emit("agent/pre-step", { task: "t", session: s })
    expect(snapshotTexts(s)).toHaveLength(1) // unchanged → no second snapshot
  })
})

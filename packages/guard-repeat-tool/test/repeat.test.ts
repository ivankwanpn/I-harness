import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession, type Session, type SessionEvent } from "@i-harness/core-session"
import { createRepeatToolGuard } from "../src/index.ts"

const GUARD = "guard-repeat-tool"

async function runPostTool(
  ctx: PluginContext,
  name: string,
  args: unknown,
  session: Session,
): Promise<void> {
  await ctx.emit("agent/post-tool", { name, args, session })
}

function isGuardReminder(e: SessionEvent): e is Extract<SessionEvent, { type: "user/message" }> {
  return (
    e.type === "user/message" &&
    e.source !== undefined &&
    e.source.kind === "plugin" &&
    e.source.plugin === GUARD
  )
}

function reminderTexts(session: Session): string[] {
  return session.events.filter(isGuardReminder).map((e) => e.text)
}

describe("guard-repeat-tool", () => {
  it("thresholds [3,5,8] fire at counts 3, 5, 8 and no more", async () => {
    const ctx = createContext()
    const session = createSession()
    ctx.mount(createRepeatToolGuard(ctx))
    for (let i = 0; i < 9; i++) {
      await runPostTool(ctx, "bash", { command: "x" }, session)
    }
    const texts = reminderTexts(session)
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain("called 3 consecutive times")
    expect(texts[1]).toContain("called 5 consecutive times")
    expect(texts[2]).toContain("called 8 consecutive times")
  })

  it("resets on a different call: second streak fires at its own 3rd call", async () => {
    const ctx = createContext()
    const session = createSession()
    ctx.mount(createRepeatToolGuard(ctx))
    for (let i = 0; i < 3; i++) {
      await runPostTool(ctx, "bash", { command: "x" }, session)
    }
    expect(reminderTexts(session)).toHaveLength(1)
    // a different call — streak resets
    await runPostTool(ctx, "bash", { command: "y" }, session)
    for (let i = 0; i < 3; i++) {
      await runPostTool(ctx, "bash", { command: "z" }, session)
    }
    const texts = reminderTexts(session)
    // exactly 2 reminders total; the NEW streak fired at its own 3rd call
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain("called 3 consecutive times")
  })

  it("exclude is transparent: excluded calls never count, never reset", async () => {
    const ctx = createContext()
    const session = createSession()
    ctx.mount(createRepeatToolGuard(ctx, { exclude: ["bash*"] }))
    await runPostTool(ctx, "bash", { command: "x" }, session) // excluded
    await runPostTool(ctx, "read", { path: "a" }, session) // read count 1
    await runPostTool(ctx, "bash", { command: "y" }, session) // excluded
    await runPostTool(ctx, "read", { path: "a" }, session) // read count 2
    await runPostTool(ctx, "read", { path: "a" }, session) // read count 3 → fires
    const texts = reminderTexts(session)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('"read"')
  })

  it("include gating: only listed tools are tracked; others neither count nor reset", async () => {
    const ctx = createContext()
    const session = createSession()
    ctx.mount(createRepeatToolGuard(ctx, { include: ["read"] }))
    await runPostTool(ctx, "write", { path: "w" }, session) // not tracked
    await runPostTool(ctx, "read", { path: "a" }, session) // read count 1
    await runPostTool(ctx, "write", { path: "w" }, session) // not tracked, no reset
    await runPostTool(ctx, "read", { path: "a" }, session) // read count 2
    await runPostTool(ctx, "read", { path: "a" }, session) // read count 3 → fires
    const texts = reminderTexts(session)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('"read"')
  })

  it("preview capped by argumentsPreviewChars", async () => {
    const ctx = createContext()
    const session = createSession()
    ctx.mount(createRepeatToolGuard(ctx, { argumentsPreviewChars: 10 }))
    const longArgs = { command: "a".repeat(80) }
    for (let i = 0; i < 3; i++) {
      await runPostTool(ctx, "bash", longArgs, session)
    }
    const texts = reminderTexts(session)
    expect(texts).toHaveLength(1)
    const preview = texts[0]!.split("Args: ")[1]!
    expect(preview.length).toBeLessThanOrEqual(10)
  })

  it("validation fails loud on bad thresholds", () => {
    const ctx = createContext()
    expect(() => createRepeatToolGuard(ctx, { thresholds: [1] })).toThrow(/thresholds/)
    expect(() => createRepeatToolGuard(ctx, { thresholds: [] })).toThrow(/thresholds/)
    expect(() => createRepeatToolGuard(ctx, { thresholds: [2.5] })).toThrow(/thresholds/)
  })

  it("per-session isolation: a streak in one session never affects another", async () => {
    const ctx = createContext()
    const s1 = createSession()
    const s2 = createSession()
    ctx.mount(createRepeatToolGuard(ctx))
    for (let i = 0; i < 3; i++) {
      await runPostTool(ctx, "bash", { command: "x" }, s1)
    }
    expect(reminderTexts(s1)).toHaveLength(1)
    expect(reminderTexts(s2)).toHaveLength(0)
    for (let i = 0; i < 3; i++) {
      await runPostTool(ctx, "bash", { command: "x" }, s2)
    }
    // s2 fires at its OWN 3rd call — if counters were shared it would inherit
    // s1's count (4, 5, 6) and fire at a different position instead.
    const s2Texts = reminderTexts(s2)
    expect(s2Texts).toHaveLength(1)
    expect(s2Texts[0]).toContain("called 3 consecutive times")
    expect(reminderTexts(s1)).toHaveLength(1)
  })

  it("no mounted listener → emit is a no-op (nothing appended)", async () => {
    const ctx = createContext()
    const session = createSession()
    await runPostTool(ctx, "bash", { command: "x" }, session)
    expect(reminderTexts(session)).toHaveLength(0)
    expect(session.events).toHaveLength(0)
  })
})

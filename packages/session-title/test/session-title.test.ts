import { describe, expect, it } from "vitest"
import { createSession, append, deriveSessionTitle } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import { fallbackTitle, normalizeTitle, suggestTitle, applyTitle, maybeAutoTitle } from "../src/index.ts"

describe("session-title", () => {
  it("fallbackTitle takes the first words of the user's message", () => {
    expect(fallbackTitle("  Implement the queue   for pending inputs,   please.  ")).toBe("Implement the queue for pending inputs, please.")
    expect(fallbackTitle("one two three four five six seven eight nine ten", 4)).toBe("one two three four...")
  })

  it("normalizeTitle strips whitespace and enforces a byte cap", () => {
    expect(normalizeTitle("  A\n\nB  ")).toBe("A\n\nB")
    const long = "x".repeat(300)
    expect(normalizeTitle(long, 80).length).toBeLessThanOrEqual(83)
  })

  it("suggestTitle uses the provider and falls back on failure; applies via applyTitle", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "Write a CLI tool for sorting files" })
    const model = createMockClient([{ role: "assistant", text: "Sort-file CLI tool" }])
    const suggested = await suggestTitle({ session, model })
    expect(suggested.title).toBe("Sort-file CLI tool")
    expect(suggested.source).toBe("provider")
    applyTitle(session, suggested.title, suggested.source, [0])
    expect(deriveSessionTitle(session)!.title).toBe("Sort-file CLI tool")

    const failingModel: ModelClient = { async *stream() { throw new Error("provider down") } }
    const fallback = await suggestTitle({ session, model: failingModel })
    expect(fallback.source).toBe("fallback")
    expect(fallback.title.length).toBeGreaterThan(0)
  })

  it("maybeAutoTitle is first-prompt mode: no-op when a title already exists", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "create a todo app" })
    const model = createMockClient([{ role: "assistant", text: "Todo app creator" }])
    await maybeAutoTitle({ session, model })
    expect(deriveSessionTitle(session)!.title).toBe("Todo app creator")
    await maybeAutoTitle({ session, model }) // second call: title exists → unchanged
    expect(session.events.filter((e) => e.type === "session/title")).toHaveLength(1)
  })
})

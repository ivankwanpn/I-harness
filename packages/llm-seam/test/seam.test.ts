import { describe, expect, it } from "vitest"
import { assertMessagesFromLog } from "../src/index.ts"
import { createSession, append } from "@i-harness/core-session"

describe("llm-seam invariant (audit F01-3)", () => {
  it("accepts messages derived from the log", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    const msgs = s.events.filter((e) => e.type === "user/message").map((e) => ({ role: "user" as const, content: (e as { text: string }).text }))
    expect(() => assertMessagesFromLog(msgs, s)).not.toThrow()
  })

  it("rejects messages NOT derived from the log", () => {
    const s = createSession()
    const foreign = [{ role: "assistant" as const, content: "not in log" }]
    expect(() => assertMessagesFromLog(foreign, s)).toThrow(/log/i)
  })
})

import { projectImagesForTextModel } from "../src/index.ts"

describe("M14 projectImagesForTextModel", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

  it("replaces image parts with a text placeholder and keeps text parts", () => {
    const out = projectImagesForTextModel([
      { role: "user", content: [
        { type: "text", text: "look" },
        { type: "image", image: { mediaType: "image/png", dataBase64: PNG } },
      ]},
    ])
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "text", text: "[image omitted: model is text-only; base64:iVBORw0K]" },
      ],
    })
  })

  it("leaves string content untouched", () => {
    const out = projectImagesForTextModel([{ role: "user", content: "plain" }])
    expect(out).toEqual([{ role: "user", content: "plain" }])
  })

  it("masks dataBase64 inside tool-role string content (M15 I3 close)", () => {
    const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const out = projectImagesForTextModel([
      { role: "tool", toolCallId: "c1", content: `{"ok":true,"images":[{"mediaType":"image/png","dataBase64":"${payload}"}]}` },
    ])
    const content = out[0]!.content as string
    expect(content).not.toContain(payload) // raw bytes never reach a text-only model
    expect(content).toContain(`"dataBase64":"[image omitted: base64:${payload.slice(0, 8)}]"`)
    expect(content).toContain(`"ok":true`) // the rest of the JSON survives
  })

  it("masks multiple base64 occurrences in one tool string", () => {
    const p1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const p2 = "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY29uZCBpbWFnZSBwYXlsb2FkISEh"
    const out = projectImagesForTextModel([
      { role: "tool", toolCallId: "c2", content: `[{"dataBase64":"${p1}"},{"dataBase64":"${p2}"}]` },
    ])
    const content = out[0]!.content as string
    expect(content).not.toContain(p1)
    expect(content).not.toContain(p2)
    expect(content).toContain(`base64:${p1.slice(0, 8)}]`)
    expect(content).toContain(`base64:${p2.slice(0, 8)}]`)
  })

  it("leaves user/assistant string content untouched even when it resembles base64", () => {
    const sneaky = `{"dataBase64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}`
    const out = projectImagesForTextModel([{ role: "user", content: sneaky }])
    expect(out[0]!.content).toBe(sneaky)
  })
})

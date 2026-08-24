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
})

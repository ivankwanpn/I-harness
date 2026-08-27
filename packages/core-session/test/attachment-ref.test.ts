import { describe, expect, it } from "vitest"
import { createSession, append } from "../src/index.ts"

// M20 Task 7: ImageInput gains optional `attachmentId?` — a durable reference
// into the @i-harness/attachment store (`att-<uuid>`), so a stored image can
// carry its store key through the log. Strictly additive:
//   - `dataBase64` stays REQUIRED (v0 keeps inline bytes in the log; refs are
//     a migration path, not a replacement).
//   - Images without `attachmentId` behave exactly as before.
describe("ImageInput.attachmentId (durable store ref)", () => {
  it("accepts attachmentId alongside the required inline dataBase64", () => {
    const s = createSession()
    append(s, {
      type: "user/message",
      text: "look",
      images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=", attachmentId: "att-123" }],
    })
    expect(s.events).toHaveLength(1)
    const ev = s.events[0]!
    expect(ev.type).toBe("user/message")
    const img = ev.type === "user/message" ? ev.images?.[0] : undefined
    expect(img?.attachmentId).toBe("att-123")
  })

  it("keeps plain inline images working (backward compat, no attachmentId)", () => {
    const s = createSession()
    append(s, {
      type: "user/message",
      text: "inline",
      images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }],
    })
    expect(s.events).toHaveLength(1)
    const ev = s.events[0]!
    const img = ev.type === "user/message" ? ev.images?.[0] : undefined
    expect(img?.mediaType).toBe("image/png")
    expect(img?.dataBase64).toBe("aGVsbG8=")
    expect(img?.attachmentId).toBeUndefined()
  })

  it("rejects a present-but-empty attachmentId (light check: non-empty when present)", () => {
    const s = createSession()
    expect(() =>
      append(s, {
        type: "user/message",
        text: "bad ref",
        images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=", attachmentId: "" }],
      }),
    ).toThrow(/attachmentId/)
  })
})

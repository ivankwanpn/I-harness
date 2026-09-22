import { describe, expect, expectTypeOf, it } from "vitest"
import { assertMessagesFromLog, clampOutputCap, describeTransportError } from "../src/index.ts"
import type { LLMRequest, ReasoningEffort } from "../src/index.ts"
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

describe("M32 reasoning effort seam", () => {
  it("defines the 6-level ReasoningEffort vocabulary", () => {
    expectTypeOf<ReasoningEffort>().toEqualTypeOf<"off" | "low" | "medium" | "high" | "xhigh" | "max">()
  })

  it("carries an optional reasoningEffort on LLMRequest (default = don't send)", () => {
    expectTypeOf<LLMRequest["reasoningEffort"]>().toEqualTypeOf<ReasoningEffort | undefined>()
  })
})

// M72 Ⅰ. `describeTransportError`'s remediation tail (NODE_USE_ENV_PROXY /
// NODE_EXTRA_CA_CERTS) is FETCH-specific advice: it describes Node's fetch
// proxy/CA behaviour. It used to be unconditional, so bedrock's own
// `AccessDeniedException` — an auth failure on the AWS SDK, where neither
// variable is read — shipped as "bedrock transport failure … unless the process
// is started with NODE_USE_ENV_PROXY=1": advice that cannot be acted on, of
// exactly the kind this phase exists to remove. The fourth parameter opts out;
// the DEFAULT keeps the fetch callers' message byte-identical (the M62 suite in
// llm-openai-compatible pins that path).
describe("M72 Ⅰ describeTransportError remediation", () => {
  it("default (fetch): keeps the transport framing and the proxy/CA tail", async () => {
    const described = await describeTransportError("openai", "https://h.example/v1/responses", new Error("fetch failed"))
    expect(described.message).toContain("openai transport failure reaching h.example")
    expect(described.message).toContain("NODE_USE_ENV_PROXY=1")
    expect(described.message).toContain("NODE_EXTRA_CA_CERTS")
  })

  it("remediation: none — no transport framing, no fetch advice, the locator still named", async () => {
    const described = await describeTransportError("bedrock", "us-east-1", new Error("AccessDeniedException: nope"), { remediation: "none" })
    expect(described.message).toBe("bedrock request failed (us-east-1): AccessDeniedException: nope")
    expect(described.message).not.toContain("transport")
    expect(described.message).not.toContain("NODE_USE_ENV_PROXY")
  })

  it("remediation: none with an empty locator omits the empty parens", async () => {
    const described = await describeTransportError("bedrock", "", new Error("boom"), { remediation: "none" })
    expect(described.message).toBe("bedrock request failed: boom")
  })

  it("keeps the abort early return and the `cause` link in BOTH branches", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
    const noneAbort = await describeTransportError("bedrock", "us-east-1", abort, { remediation: "none" })
    expect(noneAbort.message).toBe("bedrock request aborted by the caller")

    const original = new Error("AccessDeniedException: nope")
    expect((await describeTransportError("bedrock", "us-east-1", original, { remediation: "none" })).cause).toBe(original)
    expect((await describeTransportError("bedrock", "us-east-1", original)).cause).toBe(original)
  })
})

describe("M72 Ⅱ: the output cap", () => {
  it("leaves the value alone when no window is known", () => {
    expect(clampOutputCap(8192, undefined, 100_000)).toBe(8192)
  })

  it("leaves the value alone when the window has room", () => {
    expect(clampOutputCap(8192, 200_000, 1_000)).toBe(8192)
  })

  it("clamps to the room left after the estimated input and the safety margin", () => {
    // 200000 - 190000 - 4096 = 5904
    expect(clampOutputCap(65_536, 200_000, 190_000)).toBe(5904)
  })

  it("falls back to the hard room when the safety margin does not fit", () => {
    // hardRoom = 200000 - 199000 = 1000 ≥ 1, so the clamp fires; the 4096
    // margin does not fit, so the hard room is what we can still promise.
    // 199000 + 1000 = 200000 exactly, i.e. LEGAL under the provider's rule;
    // the previous expectation of 8192 was 199000 + 8192 > 200000, a 400.
    expect(clampOutputCap(8192, 200_000, 199_000)).toBe(1000)
  })

  it("clamps the measured reachable case into the hard room", () => {
    // The measured reachable case: the host's budget ladder is ok (its reserve
    // allows 9000), but the request would carry input 6000 + cap 8000 against a
    // 10000 window — a 400 on a strict provider. hardRoom = 4000.
    expect(clampOutputCap(8_192, 10_000, 6_000)).toBe(4000)
  })

  it("returns the value unchanged when the estimated input alone fills the window", () => {
    // hardRoom = 10000 - 10000 = 0 < 1 → the request cannot run at that size
    // whichever cap it carries; clamping to 1 would dress a context overflow up
    // as a truncation.
    expect(clampOutputCap(8_192, 10_000, 10_000)).toBe(8192)
  })
})

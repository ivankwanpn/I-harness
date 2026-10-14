import { expect, it } from "vitest"
import { priceProjectedText, ProjectionCounter } from "../src/index.ts"
it.each([["abc", 1], ["abcdef", 2], ["中文", 6], ["é", 2], ["🙂", 4], ["a中", 4]])("prices multilingual %s with the documented conservative UTF8 heuristic", (text, tokens) => {
  expect(priceProjectedText(text)).toBe(tokens)
})
it("keeps binary allowances and opaque uncertainty separate from ordinary text", () => {
  const counter = new ProjectionCounter()
  counter.unit({ role: "user", content: "abc" }, "user", () => counter.text("visibleText", "abc"))
  counter.image("AQID")
  counter.opaque("signed")
  const input = counter.finish({ protocol: "fixture", modelId: "m" }, { messages: ["abc"] }, { tools: [] })
  expect(input.components.visibleText).toMatchObject({ textUtf8Bytes: 3, structuredBytes: 0, binaryBytes: 0, heuristicTokens: 5 })
  expect(input.components.images).toMatchObject({ textUtf8Bytes: 0, binaryBytes: 3, imageCount: 1, heuristicTokens: 2048 })
  expect(input.components.opaqueContinuation).toMatchObject({ textUtf8Bytes: 0, binaryBytes: 6, heuristicTokens: 7 })
  expect(input.units).toEqual([{ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), role: "user", heuristicTokens: 17 }])
  expect(input.uncertainties).toEqual(["image-token-cost", "opaque-continuation-token-cost"])
})

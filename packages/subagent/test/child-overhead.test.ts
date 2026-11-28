import { expect, it } from "vitest"
import { estimateTextTokens } from "@i-harness/token-meter"
import { estimateChildOverhead } from "../src/child/prompt.ts"

it("prices a CJK system prompt and schemas with the shared density", () => {
  const system = "角色".repeat(1000)
  const schemas = [{ name: "工具", description: "描述".repeat(10) }]
  const expected = estimateTextTokens(system) + estimateTextTokens(JSON.stringify(schemas))
  expect(estimateChildOverhead(system, schemas)).toBe(expected)
  // This prompt has 2,000 Han characters. Applying the ASCII rule would count 500.
  expect(estimateChildOverhead(system, schemas)).toBeGreaterThan(Math.ceil(system.length / 4))
})

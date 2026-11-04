import { expect, it } from "vitest"
import { estimateTextTokens } from "@i-harness/token-meter"
import { estimateChildOverhead } from "../src/child/prompt.ts"

it("prices a CJK system prompt and schemas with the shared density", () => {
  const system = "角色".repeat(1000)
  const schemas = [{ name: "工具", description: "描述".repeat(10) }]
  const expected = estimateTextTokens(system) + estimateTextTokens(JSON.stringify(schemas))
  expect(estimateChildOverhead(system, schemas)).toBe(expected)
  // The old UTF-16 `.length / 4` rule would have been ~3x smaller here: 1000
  // CJK characters are 2000 UTF-16 units but 6000 UTF-8 bytes.
  expect(estimateChildOverhead(system, schemas)).toBeGreaterThan(Math.ceil(system.length / 4))
})

import { expect, it } from "vitest"
import { describeRouteBudgetCapability } from "../src/index.ts"

it.each([
  ["openai-responses", "optional", "http-json-body"],
  ["openai-compatible", "optional", "http-json-body"],
  ["anthropic-messages", "required", "http-json-body"],
  ["gemini", "optional", "http-json-body"],
  ["bedrock", "optional", "sdk-command-estimate"],
] as const)("describes %s adapter contracts without claiming a final wire cap", (protocol, outputParameter, packetKind) => {
  expect(describeRouteBudgetCapability({ protocol })).toEqual({ version: 1, route: protocol, outputParameter, packetKind, evidenceId: `adapter-budget-v1:${protocol}` })
})
it("describes subscription caps as unsupported and rejects incompatible subscription protocols", () => {
  expect(describeRouteBudgetCapability({ protocol: "openai-responses", codexSubscription: true })).toMatchObject({ route: "openai-responses-subscription", outputParameter: "unsupported" })
  expect(() => describeRouteBudgetCapability({ protocol: "gemini", codexSubscription: true })).toThrow(/subscription.*Responses/)
})

import { expect, it } from "vitest"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import { createAnthropicClient } from "@i-harness/llm-anthropic"
import { createGeminiClient } from "@i-harness/llm-gemini"
import { createBedrockClient } from "@i-harness/llm-bedrock"
import { prepareModelRequest, type LLMMessage, type ModelClient } from "@i-harness/llm-seam"

const config = { apiKey: "fixture", model: "m", providerId: "route" }
const plain = { role: "assistant", content: "unchanged" } as const
const thought = "同一段 replay text"
const thinking = { type: "thinking" as const, thinking: thought, signature: "local-sig" }
const reason = { type: "reasoning", id: "rs-a", summary: [{ type: "summary_text", text: thought }] }
async function measure(model: ModelClient, messages: LLMMessage[]) {
  return (await prepareModelRequest(model, { systemPrompt: "test", tools: [], messages })).measurement.input
}

it("assigns multiple reordered Responses items to their source assistant and ignores unplayed or overridden history", async () => {
  const assistant: Extract<LLMMessage, {role:"assistant"}> = { ...plain, toolCalls: [{id:"call",name:"read",args:{}}],
    providerContinuation:{kind:"openai-responses", model:"m",providerId:"route",reasoningItems:[reason,{...reason,id:"rs-b",summary:[]}],
      outputOrder:[{kind:"reasoning",index:1},{kind:"tool",index:0},{kind:"reasoning",index:0},{kind:"text",text:plain.content}]} }
  const repeated: LLMMessage = {...plain,providerContinuation:{kind:"openai-responses",model:"m",providerId:"route",reasoningItems:[reason]}}
  const foreign: LLMMessage = {...plain,providerContinuation:{kind:"openai-responses",model:"m",providerId:"elsewhere",reasoningItems:[reason]}}
  const messages: LLMMessage[] = [plain,assistant,{role:"tool",toolCallId:"call",content:"ok"},foreign,repeated]
  const original = await measure(createOpenAIClient(config),messages)
  const paid = original.units.filter(unit => unit.replayedReasoningTokens !== undefined)
  expect(paid.map(unit => unit.sourceAssistantOrdinal)).toEqual([1,1,3])
  expect(paid[0]!.replayedReasoningTokens!).toBeLessThan(paid[1]!.replayedReasoningTokens!)
  expect(paid[1]!.replayedReasoningTokens).toBe(paid[2]!.replayedReasoningTokens)
  expect(paid.reduce((sum,unit)=>sum + unit.replayedReasoningTokens!,0)).toBe(original.components.replayedReasoning.heuristicTokens)
  const override = await measure(createOpenAIClient({...config,options:{input:[reason]}}),messages)
  expect(override.components.replayedReasoning.heuristicTokens).toBeGreaterThan(0)
  expect(override.overriddenInputFields).toContain("messages")
  expect(override.units.every(unit => unit.sourceAssistantOrdinal === undefined && unit.replayedReasoningTokens === undefined)).toBe(true)
})

it.each(["chat","messages","gemini","bedrock"] as const)("preserves actual replay owner ordinals for %s, including identical exchanges", async protocol => {
  let model: ModelClient, native: Extract<LLMMessage, { role:"assistant" }>
  switch (protocol) {
    case "chat":
      model = createOpenAICompatibleClient(config)
      native = {...plain,providerContinuation:{kind:"openai-compatible",model:"m",providerId:"route",reasoningContent:thought}}
      break
    case "messages":
      model = createAnthropicClient(config)
      native = {...plain,thinkingBlocks:[thinking],providerContinuation:{kind:"anthropic",model:"m",providerId:"route"}}
      break
    case "gemini":
      model = createGeminiClient(config)
      native = {...plain,providerContinuation:{kind:"gemini",model:"m",providerId:"route",callSignatures:[],thoughtParts:[{text:thought}]}}
      break
    case "bedrock":
      model = createBedrockClient({model:"m",providerId:"route",region:"us-east-1"})
      native = {...plain,providerContinuation:{kind:"bedrock",model:"m",providerId:"route",reasoningBlocks:[{reasoningText:{text:thought,signature:"local-sig"}}]}}
      break
  }
  const input = await measure(model,[plain,native,{role:"user",content:"new input"},plain,native])
  const owned = input.units.filter(unit => unit.sourceAssistantOrdinal !== undefined)
  expect(owned.map(unit=>unit.sourceAssistantOrdinal)).toEqual([1,3])
  expect(owned[0]!.replayedReasoningTokens).toBe(owned[1]!.replayedReasoningTokens)
  expect(owned[0]!.replayedReasoningTokens! * 2).toBe(input.components.replayedReasoning.heuristicTokens)
})

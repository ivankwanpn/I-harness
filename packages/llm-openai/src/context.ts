import { ProjectionCounter } from "@i-harness/token-meter"
import { invalidPreparedRequest, type LLMRequest } from "@i-harness/llm-seam"
import type { OpenAIConfig } from "./types.ts"
export function describeContext(body: Record<string, unknown>, config: OpenAIConfig, subscription: boolean) {
  if (body.model !== config.model)
    throw invalidPreparedRequest("Actual request model does not match the resolved binding", "MODEL_BINDING_MISMATCH")
  const counter = new ProjectionCounter()
  counter.metadata(body)
  let referencedInput = false
  if (!subscription && config.baseUrl !== undefined && !/^https:\/\/api\.openai\.com\/?$/.test(config.baseUrl))
    counter.uncertainties.add("route-output-floor-unverified")
  counter.text("system", body.instructions)
  counter.structured("toolSchemas", body.tools)
  function block(value: unknown, textComponent: "system" | "visibleText" = "visibleText"): void {
    if (!value || typeof value !== "object") {
      counter.text("otherInput", value)
      return
    }
    const item = value as Record<string, unknown>
    counter.metadata(item)
    if (item.type === "input_file") {
      referencedInput = true
      counter.uncertainties.add("server-referenced-context-unavailable")
      // File tokenization/expansion remains unknown even for inline file_data.
      if (item.file_data !== undefined)
        counter.opaque(item.file_data)
    }
    else if (item.type === "input_image") {
      const image = String(item.image_url ?? "")
      if (image.startsWith("data:"))
        counter.image(image.slice(image.indexOf(",") + 1))
      else {
        referencedInput = true
        counter.image(undefined)
        counter.uncertainties.add("external-image-token-cost")
      }
    }
    else if (item.type === "reasoning") {
      counter.structured("replayedReasoning", item.summary)
      if (item.encrypted_content !== undefined)
        counter.opaque(item.encrypted_content)
      // Native reasoning text is eligible only if the mapper actually retained it.
      if (item.content !== undefined)
        counter.structured("replayedReasoning", item.content)
    }
    else if (item.type === "function_call")
      counter.structured("toolArguments", { name: item.name, namespace: item.namespace, call_id: item.call_id, arguments: item.arguments })
    else if (item.type === "function_call_output") {
      if (Array.isArray(item.output))
        for (const part of item.output) {
          if (part?.type === "input_image" || part?.type === "input_file")
            block(part)
          else if (part?.text !== undefined)
            counter.text("toolResults", part.text)
          else
            counter.structured("toolResults", part)
        }
      else
        counter.text("toolResults", item.output)
    }
    else if (Array.isArray(item.content))
      for (const part of item.content)
        block(part, textComponent)
    else if (typeof item.content === "string")
      counter.text(textComponent, item.content)
    else if (item.text !== undefined)
      counter.text(textComponent, item.text)
    else
      counter.structured("otherInput", item)
  }
  const fixedInput: unknown[] = []
  if (Array.isArray(body.input))
    for (const item of body.input) {
      const node = item as Record<string, unknown>
      if (node.role === "system" || node.role === "developer") {
        fixedInput.push(item)
        counter.structured("framing", { role: node.role })
        block(item, "system")
        continue
      }
      const role = node.role === "assistant" || node.type === "reasoning" || node.type === "function_call" ? "assistant" : node.type === "function_call_output" ? "tool" : "user"
      counter.unit(item, role, () => block(item))
    }
  else
    counter.text("visibleText", body.input)
  const references = referencedInput || body.previous_response_id !== undefined || body.conversation !== undefined || body.prompt !== undefined
  if (references)
    counter.uncertainties.add("server-referenced-context-unavailable")
  const excluded = new Set(["model", "instructions", "input", "tools", "max_output_tokens", "reasoning", "stream", "store", "include", "previous_response_id", "conversation", "prompt", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "service_tier", "client_metadata", "parallel_tool_calls"])
  const other = Object.fromEntries(Object.entries(body).filter(([key]) => !excluded.has(key)))
  counter.structured("otherInput", other)
  const overrides: ("model" | "system" | "messages" | "tools")[] = []
  if (!subscription)
    for (const [wire, field] of [["model", "model"], ["instructions", "system"], ["input", "messages"], ["tools", "tools"]] as const)
      if (Object.hasOwn(config.options ?? {}, wire))
        overrides.push(field)
  const input = counter.finish({ protocol: subscription ? "openai-responses-subscription" : "openai-responses", providerId: config.providerId, modelId: config.model, expectedModelId: config.model }, { instructions: body.instructions, input: body.input, tools: body.tools, other, previous_response_id: body.previous_response_id, conversation: body.conversation, prompt: body.prompt }, { instructions: body.instructions, tools: body.tools, subscription, ...(fixedInput.length ? { fixedInput } : {}) }, overrides, references ? "incomplete" : "complete")
  return { input, packet: { sizeKind: "http-json-body" as const, inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: counter.cacheMetadataBytes, signatureBytes: counter.signatureBytes } }
}
export function outputFacts(body: Record<string, unknown>, request: LLMRequest, config: OpenAIConfig, subscription: boolean) {
  if (body.max_output_tokens !== undefined && typeof body.max_output_tokens !== "number")
    throw invalidPreparedRequest("Responses output cap is invalid")
  return {
    capSupport: subscription ? "unsupported" as const : "supported" as const,
    configuredCap: request.maxOutputTokens ?? (typeof config.options?.max_output_tokens === "number" ? config.options.max_output_tokens : undefined),
    effectiveCap: !subscription && typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
    minimumCap: !subscription && (config.baseUrl === undefined || /^https:\/\/api\.openai\.com\/?$/.test(config.baseUrl)) ? 16 : 1, source: request.maxOutputTokens !== undefined ? "request" as const : config.options?.max_output_tokens !== undefined ? "route" as const : "provider-default" as const
  }
}

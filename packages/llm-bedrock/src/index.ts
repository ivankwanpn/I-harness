import { projectImagesForTextModel, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime"
import type { BedrockRuntimeClient as BedrockRuntimeClientClass, ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime"

export interface BedrockConfig {
  /** Required by the Converse API (`modelId` — an ARN or the model id). */
  model: string
  region?: string
  /** AWS credential-profile name (the SDK's credential chain resolves it). */
  profile?: string
  /** Extra model parameters → additionalModelRequestFields (Converse only
   * accepts maxTokens/temperature/topP/stopSequences in inferenceConfig). */
  options?: Record<string, unknown>
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping.
  inputModalities?: ("text" | "image")[]
}

/** The runtime-client face the adapter needs. A caller may inject a fake with
 * this shape (tests inject one — no network, no AWS credential chain). */
export type BedrockRuntimeFace = Pick<BedrockRuntimeClientClass, "send" | "destroy">

/** Region chain: config.region → AWS_REGION → AWS_DEFAULT_REGION → us-east-1. */
export function resolveBedrockRegion(
  region: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1"
}

// Shape LLM content parts into Converse content blocks. String content stays
// one text block (byte-identical). Images use the Converse ImageBlock
// ({format, source:{bytes}}); media types outside the four Converse image
// formats are sent as PNG-lite by the sub-type fallback.
function toConverseContent(content: string | LLMContentPart[]): unknown[] {
  if (typeof content === "string") return [{ text: content }]
  return content.map((part) =>
    part.type === "text"
      ? { text: part.text }
      : { image: { format: imageFormatOf(part.image.mediaType), source: { bytes: Buffer.from(part.image.dataBase64, "base64") } } },
  )
}

function imageFormatOf(mediaType: string): "png" | "jpeg" | "gif" | "webp" {
  const sub = mediaType.split("/")[1]?.toLowerCase() ?? "png"
  return sub === "jpeg" || sub === "gif" || sub === "webp" ? sub : "png"
}

// A Converse toolResult content block: valid-JSON object content is passed
// through as { json }, anything else becomes a { text } block.
function toolResultContent(content: string | LLMContentPart[]): unknown[] {
  const raw = typeof content === "string"
    ? content
    : content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n")
  if (raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return [{ json: parsed }]
    } catch {
      // not JSON — text below
    }
  }
  return [{ text: raw }]
}

export function createBedrockClient(config: BedrockConfig, runtime?: BedrockRuntimeFace): ModelClient {
  // One runtime client per adapter (credential chain resolved once at
  // construction); a test-injected fake skips both the chain and the network.
  const client = runtime ?? new BedrockRuntimeClient({
    region: resolveBedrockRegion(config.region, process.env),
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
  })
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const vision = config.inputModalities?.includes("image") ?? false
      const messages = vision ? request.messages : projectImagesForTextModel(request.messages)
      const body: ConverseStreamCommandInput = {
        modelId: config.model,
        ...(request.systemPrompt.trim() !== "" ? { system: [{ text: request.systemPrompt }] } : {}),
        messages: messages.map((m) => {
          if (m.role === "tool") {
            return {
              role: "user",
              content: [{ toolResult: { toolUseId: m.toolCallId, content: toolResultContent(m.content) } }],
            }
          }
          if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
            const content: unknown[] = m.content.trim() !== "" ? [{ text: m.content }] : []
            for (const c of m.toolCalls) {
              content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.args as Record<string, unknown> } })
            }
            return { role: "assistant", content }
          }
          return { role: m.role, content: toConverseContent(m.content) }
        }) as ConverseStreamCommandInput["messages"],
        ...(request.tools.length > 0
          ? { toolConfig: { tools: request.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) } as ConverseStreamCommandInput["toolConfig"] }
          : {}),
        ...(config.options !== undefined
          ? { additionalModelRequestFields: config.options as ConverseStreamCommandInput["additionalModelRequestFields"] }
          : {}),
      }
      const output = await client.send(new ConverseStreamCommand(body))
      // Tool-use accumulation per content block (the ConverseStream wire):
      // a toolUse delta carries the args as one JSON string split across
      // deltas; the stop event completes the block, and the args are parsed
      // there (mirrors the llm-openai-compatible accumulation).
      const pendingToolUses = new Map<number, { id: string; name: string; buffer: string }>()
      // Soft-walk the SDK's discriminated member union: every member key is
      // declared as `?: never` on its siblings, so TS's `in` narrowing cannot
      // split the union — runtime key checks behave like the wire shape.
      const handleMember = (member: unknown): LLMStreamEvent[] => {
        const m = member as {
          contentBlockStart?: { contentBlockIndex?: number; start?: { toolUse?: { toolUseId?: string; name?: string } } }
          contentBlockDelta?: { contentBlockIndex?: number; delta?: { text?: string; toolUse?: { input?: string }; reasoningContent?: { text?: string } } }
          contentBlockStop?: { contentBlockIndex?: number }
          messageStop?: { stopReason?: string }
          metadata?: { usage?: unknown }
          internalServerException?: { message?: string }
          modelStreamErrorException?: { message?: string }
          serviceUnavailableException?: { message?: string }
          throttlingException?: { message?: string }
          validationException?: { message?: string }
        }
        if (m.contentBlockStart !== undefined && m.contentBlockStart.start?.toolUse !== undefined) {
          const toolUse = m.contentBlockStart.start.toolUse
          pendingToolUses.set(m.contentBlockStart.contentBlockIndex ?? 0, {
            id: toolUse.toolUseId ?? "",
            name: toolUse.name ?? "",
            buffer: "",
          })
          return []
        }
        if (m.contentBlockDelta !== undefined) {
          const delta = m.contentBlockDelta.delta
          if (delta !== undefined) {
            if (typeof delta.text === "string" && delta.text.length > 0) {
              return [{ type: "text/chunk", text: delta.text }]
            }
            if (delta.toolUse !== undefined) {
              const pending = pendingToolUses.get(m.contentBlockDelta.contentBlockIndex ?? 0)
              if (pending !== undefined && typeof delta.toolUse.input === "string") {
                pending.buffer += delta.toolUse.input
              }
              return []
            }
            if (delta.reasoningContent !== undefined && typeof delta.reasoningContent.text === "string") {
              return [{ type: "reasoning", text: delta.reasoningContent.text }]
            }
          }
          return []
        }
        if (m.contentBlockStop !== undefined) {
          const pending = pendingToolUses.get(m.contentBlockStop.contentBlockIndex ?? 0)
          pendingToolUses.delete(m.contentBlockStop.contentBlockIndex ?? 0)
          if (pending !== undefined) {
            try {
              const args = JSON.parse(pending.buffer.trim() === "" ? "{}" : pending.buffer) as unknown
              return [{ type: "tool_call", call: { name: pending.name, args } }]
            } catch {
              return [{
                type: "error",
                error: new Error(`bedrock malformed tool use args for "${pending.name}": ${pending.buffer}`),
              }]
            }
          }
          return []
        }
        // messageStart/messageStop carry no stream content (messageStop
        // terminates the stream → `end` below); metadata carries the usage
        // snapshot (inputTokens/outputTokens/totalTokens) — the seam's
        // LLMStreamEvent vocabulary has NO usage event (same gap as
        // llm-anthropic / llm-gemini), so the wire position is documented here.
        const exceptions = [
          m.internalServerException, m.modelStreamErrorException, m.serviceUnavailableException,
          m.throttlingException, m.validationException,
        ]
        for (const exception of exceptions) {
          if (exception !== undefined) {
            const raw = exception as { message?: unknown }
            const message = typeof raw.message === "string" ? raw.message : "unknown stream error"
            return [{ type: "error", error: new Error(`bedrock stream failed: ${message}`) }]
          }
        }
        return []
      }
      for await (const member of output.stream ?? []) {
        const events = handleMember(member)
        for (const ev of events) {
          yield ev
          if (ev.type === "error") return // error is terminal — no `end`
        }
      }
      yield { type: "end" }
    },
  }
}

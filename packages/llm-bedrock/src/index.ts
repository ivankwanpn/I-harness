import { canReplayContinuation, describeTransportError, projectImagesForTextModel, replayBlockOrder, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type LLMUsage, type ModelClient, type ProviderBlockOrderEntry, type ReasoningEffort } from "@i-harness/llm-seam"
import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime"
import type { BedrockRuntimeClient as BedrockRuntimeClientClass, ConverseStreamCommandInput, ConverseStreamCommandOutput } from "@aws-sdk/client-bedrock-runtime"

/**
 * M72 Ⅲ: the wire's usage snapshot, under the seam's names.
 *
 * Returns `undefined` when the object carries no recognisable number, so the
 * caller emits NO event rather than an empty one: a fabricated `0` would read
 * as a measurement nobody made, and the SDK's `TokenUsage` declares the two
 * cache counts optional. Fields are copied verbatim and never derived —
 * `totalTokens` is the wire's own sum of the two counts, not a new measurement,
 * so it is not mapped (`LLMUsage` has no home for it). The two cache counts take
 * the names anthropic's cache read/creation counts take. The field list is
 * MEASURED from the installed SDK's `TokenUsage`, not assumed.
 */
function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const src = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: string, to: Exclude<keyof LLMUsage, "inputTokenSemantics">): void => {
    const v = src[from]
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("inputTokens", "inputTokens")
  take("outputTokens", "outputTokens")
  take("cacheReadInputTokens", "cacheReadTokens")
  take("cacheWriteInputTokens", "cacheCreationTokens")
  // Converse inputTokens excludes both cache reads and cache writes (AWS
  // prompt-caching guide); preserve raw counters and declare that accounting.
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "excludes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}

export interface BedrockConfig {
  /** Required by the Converse API (`modelId` — an ARN or the model id). */
  model: string
  providerId?: string
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
/**
 * M32 generation rule: claude 4.x minor ≥ 6 (e.g. claude-sonnet-4-6 /
 * claude-opus-4-7+, also -4.6 style and anything later) uses the adaptive
 * protocol; every older generation uses the legacy budget protocol.
 */
const ADAPTIVE_CLAUDE_RE = /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4[-.](?:6|7|8|9|[1-9][0-9]+)|[5-9](?:[-.]|$))/

/** Converse expects a number in the legacy budget slot. */
function legacyBudgetTokens(effort: "low" | "medium" | "high" | "xhigh" | "max"): number {
  return effort === "low" ? 2048 : effort === "medium" ? 8192 : effort === "high" ? 16384 : effort === "xhigh" ? 32768 : 65536
}

/** Wire fields for `additionalModelRequestFields` (the adapter's free-form
 * extra-parameters channel — Converse only accepts maxTokens/temperature/
 * topP/stopSequences in inferenceConfig). */
export interface BedrockReasoningFields {
  reasoningConfig?: { type: "enabled"; maxReasoningEffort: "low" | "medium" | "high" }
  thinking?: { type: "adaptive" } | { type: "enabled"; budget_tokens: number }
  output_config?: { effort: string }
}

/**
 * M32 bedrock translation table with generation rules:
 * - Claude 4.6+ → `thinking:{type:"adaptive"}` plus
 *   `output_config:{effort}` in additionalModelRequestFields.
 * - Claude ≤4.5 → `thinking:{type:"enabled",budget_tokens:N}`.
 * - Amazon Nova → `reasoningConfig:{type:"enabled",maxReasoningEffort}`
 *   with the three levels Nova accepts.
 * - Unknown families reject an explicit effort locally.
 * - "off" → undefined (do not include any thinking fields).
 */
export function translateReasoning(model: string, effort: ReasoningEffort | undefined): BedrockReasoningFields | undefined {
  if (effort === undefined || effort === "off") return undefined
  if (/claude/i.test(model)) {
    if (ADAPTIVE_CLAUDE_RE.test(model)) {
      return { thinking: { type: "adaptive" }, output_config: { effort } }
    }
    return { thinking: { type: "enabled", budget_tokens: legacyBudgetTokens(effort) } }
  }
  if (/nova/i.test(model)) {
    return { reasoningConfig: { type: "enabled", maxReasoningEffort: effort === "low" || effort === "medium" ? effort : "high" } }
  }
  throw new Error(`Bedrock model does not have a known reasoning wire: ${model}`)
}

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

// Converse's ToolResultBlock.status is accepted only by Nova and Claude 3/4.
// Other Bedrock models still receive the error text, without an unsupported field.
function supportsToolResultStatus(model: string): boolean {
  // Converse accepts both foundation-model IDs and inference-profile IDs,
  // including regional/global prefixes and ARN resource suffixes.
  const resource = model.split("/").at(-1) ?? model
  const id = resource.replace(/^[a-z][a-z0-9-]*\.(?=(?:anthropic|amazon)\.)/, "")
  return /^amazon\.nova(?:[-.]|$)/.test(id)
    || /^anthropic\.claude-(?:3(?:-|$)|(?:haiku|sonnet|opus)-[34](?:-|$))/.test(id)
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
      // M32: request-level effort wins over config.options (explicit per-request intent).
      const reasoning = translateReasoning(config.model, request.reasoningEffort)
      const legacyThinking = reasoning?.thinking?.type === "enabled" ? reasoning.thinking : undefined
      const outputLimit = request.maxOutputTokens ?? (legacyThinking ? 8192 : undefined)
      if (legacyThinking && outputLimit !== undefined && outputLimit <= 1024) {
        yield { type: "error", error: new Error("Bedrock Claude thinking requires maxTokens above 1024") }
        return
      }
      const effectiveReasoning = legacyThinking && outputLimit !== undefined
        ? { ...reasoning, thinking: { type: "enabled" as const, budget_tokens: Math.min(legacyThinking.budget_tokens, outputLimit - 1) } }
        : reasoning
      const wireMessages: { role: "user" | "assistant"; content: unknown[] }[] = []
      let toolResults: unknown[] | undefined
      for (const m of messages) {
        if (m.role === "tool") {
          if (toolResults === undefined) {
            toolResults = []
            wireMessages.push({ role: "user", content: toolResults })
          }
          toolResults.push({ toolResult: { toolUseId: m.toolCallId, content: toolResultContent(m.content), ...(m.isError === true && supportsToolResultStatus(config.model) ? { status: "error" } : {}) } })
          continue
        }
        toolResults = undefined
        if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
          const continuation = m.providerContinuation?.kind === "bedrock" && canReplayContinuation(m.providerContinuation, config)
            ? m.providerContinuation : undefined
          const blocks = continuation
            ? continuation.reasoningBlocks.map((block) => "reasoningText" in block ? { reasoningContent: { reasoningText: block.reasoningText } } : { reasoningContent: { redactedContent: Buffer.from(block.redactedContentBase64, "base64") } }) : []
          const tools = m.toolCalls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.args as Record<string, unknown> } }))
          const content: unknown[] = replayBlockOrder<unknown>(continuation?.contentOrder, m.content, blocks, tools, (text) => ({ text }))
            ?? [...blocks, ...(m.content.trim() !== "" ? [{ text: m.content }] : []), ...tools]
          wireMessages.push({ role: "assistant", content })
          continue
        }
        wireMessages.push({ role: m.role, content: toConverseContent(m.content) })
      }
      const body: ConverseStreamCommandInput = {
        modelId: config.model,
        ...(request.systemPrompt.trim() !== "" ? { system: [{ text: request.systemPrompt }] } : {}),
        messages: wireMessages as ConverseStreamCommandInput["messages"],
        ...(request.tools.length > 0
          ? { toolConfig: { tools: request.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) } as ConverseStreamCommandInput["toolConfig"] }
          : {}),
        ...(config.options !== undefined || effectiveReasoning !== undefined
          ? { additionalModelRequestFields: { ...(config.options ?? {}), ...(effectiveReasoning ?? {}) } as ConverseStreamCommandInput["additionalModelRequestFields"] }
          : {}),
        // M72 Ⅱ: Converse accepts maxTokens ONLY inside inferenceConfig, which
        // this adapter has never built (every option went to
        // additionalModelRequestFields, which the wire does not read for it).
        ...(outputLimit !== undefined
          ? { inferenceConfig: { maxTokens: outputLimit } }
          : {}),
      }
      // M61: the AWS SDK takes the abort at the REQUEST level — cancel must
      // kill a parked Converse call, not wait for the first event.
      let output: ConverseStreamCommandOutput
      try {
        output = await client.send(
          new ConverseStreamCommand(body),
          request.signal !== undefined ? { abortSignal: request.signal } : {},
        )
      } catch (err) {
        // M72 Ⅰ: M61's cancel and every request-level failure (auth, throttling,
        // network) used to escape as a raw SDK throw, bypassing the seam's error
        // channel the other four adapters use. Abort is NOT a provider failure:
        // it keeps today's behaviour (a throw out of the generator).
        if (request.signal?.aborted === true) throw err
        yield { type: "error", error: await describeTransportError("bedrock", resolveBedrockRegion(config.region, process.env), err, { remediation: "none" }) }
        return
      }
      // Tool-use accumulation per content block (the ConverseStream wire):
      // a toolUse delta carries the args as one JSON string split across
      // deltas; the stop event completes the block, and the args are parsed
      // there (mirrors the llm-openai-compatible accumulation).
      const pendingToolUses = new Map<number, { id: string; name: string; buffer: string }>()
      const pendingReasoning = new Map<number, { text: string; signature: string }>()
      const pendingRedacted = new Map<number, Uint8Array[]>()
      const reasoningBlocks: ({ reasoningText: { text: string; signature: string } } | { redactedContentBase64: string })[] = []
      const blockOrder = new Map<number, ProviderBlockOrderEntry>()
      let toolOrdinal = 0
      // M72 Ⅱ: the wire's own truncation literal (`messageStop.stopReason:
      // "max_tokens"`) — set in `handleMember` below, read once at the ending.
      // Absent stays absent: only `true` writes the field.
      let truncated = false
      // M77: the same `stopReason` carries this wire's refusal literal,
      // `guardrail_intervened` (a guardrail stopped the exchange) — which
      // arrives as an ordinary HTTP 200 stream, so before M77 the seam reported
      // an empty SUCCESS. A separate variable from `truncated`: the two are
      // independent and neither is the other's `else`. Sibling stop reasons this
      // unit does NOT treat as refusals (measured in the AWS SDK's own
      // `StopReason` enum in this tree's node_modules, unread here on purpose):
      // `content_filtered`, `malformed_model_output`, `malformed_tool_use`,
      // `model_context_window_exceeded` — recorded as a residual, not guessed at.
      let refused = false
      // Soft-walk the SDK's discriminated member union: every member key is
      // declared as `?: never` on its siblings, so TS's `in` narrowing cannot
      // split the union — runtime key checks behave like the wire shape.
      const handleMember = (member: unknown): LLMStreamEvent[] => {
        const m = member as {
          contentBlockStart?: { contentBlockIndex?: number; start?: { toolUse?: { toolUseId?: string; name?: string } } }
          contentBlockDelta?: { contentBlockIndex?: number; delta?: { text?: string; toolUse?: { input?: string }; reasoningContent?: { text?: string; signature?: string; redactedContent?: Uint8Array } } }
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
          blockOrder.set(m.contentBlockStart.contentBlockIndex ?? 0, { kind: "tool", index: toolOrdinal++ })
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
              const index = m.contentBlockDelta.contentBlockIndex ?? 0
              const entry = blockOrder.get(index)
              if (entry?.kind === "text") entry.text += delta.text
              else blockOrder.set(index, { kind: "text", text: delta.text })
              return [{ type: "text/chunk", text: delta.text }]
            }
            if (delta.toolUse !== undefined) {
              const pending = pendingToolUses.get(m.contentBlockDelta.contentBlockIndex ?? 0)
              if (pending !== undefined && typeof delta.toolUse.input === "string") {
                pending.buffer += delta.toolUse.input
              }
              return []
            }
            if (delta.reasoningContent !== undefined) {
              const index = m.contentBlockDelta.contentBlockIndex ?? 0
              const block = delta.reasoningContent
              if (block.redactedContent instanceof Uint8Array) {
                const fragments = pendingRedacted.get(index) ?? []
                fragments.push(block.redactedContent)
                pendingRedacted.set(index, fragments)
              }
              if (typeof block.text === "string" || typeof block.signature === "string") {
                const pending = pendingReasoning.get(index) ?? { text: "", signature: "" }
                pending.text += block.text ?? ""
                pending.signature += block.signature ?? ""
                pendingReasoning.set(index, pending)
              }
              if (typeof block.text === "string") return [{ type: "reasoning", blockId: String(index), text: block.text }]
            }
          }
          return []
        }
        if (m.contentBlockStop !== undefined) {
          const index = m.contentBlockStop.contentBlockIndex ?? 0
          const redacted = pendingRedacted.get(index)
          if (redacted) {
            pendingRedacted.delete(index)
            reasoningBlocks.push({ redactedContentBase64: Buffer.concat(redacted.map((bytes) => Buffer.from(bytes))).toString("base64") })
            blockOrder.set(index, { kind: "reasoning", index: reasoningBlocks.length - 1 })
          }
          const reasoning = pendingReasoning.get(index)
          if (reasoning) {
            pendingReasoning.delete(m.contentBlockStop.contentBlockIndex ?? 0)
            if (reasoning.signature) {
              reasoningBlocks.push({ reasoningText: reasoning })
              blockOrder.set(index, { kind: "reasoning", index: reasoningBlocks.length - 1 })
            }
          }
          const pending = pendingToolUses.get(m.contentBlockStop.contentBlockIndex ?? 0)
          pendingToolUses.delete(m.contentBlockStop.contentBlockIndex ?? 0)
          if (pending !== undefined) {
            try {
              const args = JSON.parse(pending.buffer.trim() === "" ? "{}" : pending.buffer) as unknown
              return [{ type: "tool_call", call: { ...(pending.id ? { id: pending.id } : {}), name: pending.name, args } }]
            } catch {
              return [{
                type: "error",
                error: new Error(`bedrock malformed tool use args for "${pending.name}": ${pending.buffer}`),
              }]
            }
          }
          return []
        }
        // M72 Ⅱ: `messageStop` IS read now — it is where this wire states WHY
        // the stream ended, and `stopReason` is the truncation literal the
        // seam's `end` bit takes. It carries no other stream content (it
        // terminates the stream → `end` below); `messageStart` carries none at
        // all. `metadata` carries the usage snapshot (the Converse
        // `TokenUsage`) — until M72 Ⅲ this adapter documented that wire position
        // here instead of surfacing it; the arm below now maps it onto the
        // seam's own `usage` event (`{ type: "usage"; usage: LLMUsage }`).
        if (m.messageStop?.stopReason === "max_tokens") truncated = true
        // M77: the refusal on the very same field — a sibling test, never the
        // `else` of the truncation above.
        if (m.messageStop?.stopReason === "guardrail_intervened") refused = true
        // M72 Ⅲ: `metadata` carries the round-trip's usage snapshot — typed
        // here since the beginning and never read. Same two rules as every
        // other adapter: finite numbers only, and nothing recognisable ⇒ no
        // event at all.
        const usage = mapUsage(m.metadata?.usage)
        if (usage !== undefined) return [{ type: "usage", usage }]
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
      try {
        for await (const member of output.stream ?? []) {
          const events = handleMember(member)
          for (const ev of events) {
            yield ev
            if (ev.type === "error") return // error is terminal — no `end`
          }
        }
      } catch (err) {
        // M72 Ⅰ: the read loop was the last unguarded one — the four SSE
        // adapters got this catch in Task 4, and without it a failure AFTER the
        // 200 (a dropped connection, an SDK-level stream error) escaped as a raw
        // throw, bypassing both the diagnosis below and the seam's error channel.
        // Abort is NOT a provider failure: a cancelled read keeps today's
        // behaviour (a throw out of the generator).
        if (request.signal?.aborted === true) throw err
        yield { type: "error", error: await describeTransportError("bedrock", resolveBedrockRegion(config.region, process.env), err, { remediation: "none" }) }
        return
      }
      // M77: each bit is written on its own (a response can be both), and both
      // absent ⇒ the byte-exact `{ type: "end" }` every clean ending returned.
      const contentOrder = [...blockOrder.entries()].sort(([left], [right]) => left - right).map(([, entry]) => entry)
      const rank = { reasoning: 0, text: 1, tool: 2 } as const
      let previousRank = -1
      const interleaved = contentOrder.some((entry) => {
        const current = rank[entry.kind]
        const outOfOrder = current < previousRank
        previousRank = Math.max(previousRank, current)
        return outOfOrder
      })
      yield { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(reasoningBlocks.length || interleaved ? { providerContinuation: { kind: "bedrock", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), reasoningBlocks, ...(interleaved ? { contentOrder } : {}) } as const } : {}) }
    },
  }
}

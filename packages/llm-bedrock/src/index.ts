import { describeTransportError, projectImagesForTextModel, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type LLMUsage, type ModelClient, type ReasoningEffort } from "@i-harness/llm-seam"
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
  const take = (from: string, to: keyof LLMUsage): void => {
    const v = src[from]
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("inputTokens", "inputTokens")
  take("outputTokens", "outputTokens")
  take("cacheReadInputTokens", "cacheReadTokens")
  take("cacheWriteInputTokens", "cacheCreationTokens")
  return Object.keys(out).length > 0 ? out : undefined
}

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
/**
 * M32 generation rule: claude 4.x minor ≥ 6 (e.g. claude-sonnet-4-6 /
 * claude-opus-4-7+, also -4.6 style and anything later) uses the adaptive
 * protocol; every older generation uses the legacy budget protocol.
 */
const ADAPTIVE_CLAUDE_RE = /\-4[-.](?:6|7|8|9|[1-9][0-9]+)/

/** M32 legacy budget table (documented mapping): low/medium/high only. */
function legacyBudgetTokens(effort: "low" | "medium" | "high" | "xhigh" | "max"): number | string {
  return effort === "low" ? 2048 : effort === "medium" ? 8192 : effort === "high" ? 16384 : effort
}

/** Wire fields for `additionalModelRequestFields` (the adapter's free-form
 * extra-parameters channel — Converse only accepts maxTokens/temperature/
 * topP/stopSequences in inferenceConfig). */
export interface BedrockReasoningFields {
  reasoningConfig?: { type: "adaptive"; maxReasoningEffort: string }
  thinking?: { type: "adaptive" }
  thinkingConfig?: { type: "enabled"; budgetTokens: number | string }
}

/**
 * M32 bedrock translation table with generation rules:
 * - claude 4.6+ → `additionalModelRequestFields`:
 *   `reasoningConfig:{type:"adaptive", maxReasoningEffort:<effort verbatim>}`
 *   + `thinking:{type:"adaptive"}`.
 * - claude ≤4.5 → `thinkingConfig:{type:"enabled", budgetTokens:<documented
 *   table>}`; effort is NEVER sent (xhigh/max land verbatim in budgetTokens →
 *   provider 400, fail-loud).
 * - amazon nova → its own adaptive `reasoningConfig`; effort verbatim.
 * - unknown family → the legacy thinkingConfig shape (a model that rejects it
 *   surfaces its 400 — fail-loud, never silently drop the effort).
 * - "off" → undefined (do not include any thinking fields).
 */
export function translateReasoning(model: string, effort: ReasoningEffort | undefined): BedrockReasoningFields | undefined {
  if (effort === undefined || effort === "off") return undefined
  if (/claude/i.test(model)) {
    if (ADAPTIVE_CLAUDE_RE.test(model)) {
      return { reasoningConfig: { type: "adaptive", maxReasoningEffort: effort }, thinking: { type: "adaptive" } }
    }
    return { thinkingConfig: { type: "enabled", budgetTokens: legacyBudgetTokens(effort) } }
  }
  if (/nova/i.test(model)) {
    return { reasoningConfig: { type: "adaptive", maxReasoningEffort: effort } }
  }
  return { thinkingConfig: { type: "enabled", budgetTokens: legacyBudgetTokens(effort) } }
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
        ...(config.options !== undefined || reasoning !== undefined
          ? { additionalModelRequestFields: { ...(config.options ?? {}), ...(reasoning ?? {}) } as ConverseStreamCommandInput["additionalModelRequestFields"] }
          : {}),
        // M72 Ⅱ: Converse accepts maxTokens ONLY inside inferenceConfig, which
        // this adapter has never built (every option went to
        // additionalModelRequestFields, which the wire does not read for it).
        ...(request.maxOutputTokens !== undefined
          ? { inferenceConfig: { maxTokens: request.maxOutputTokens } }
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
      yield { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}) }
    },
  }
}

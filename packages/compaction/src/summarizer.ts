import { prepareModelRequest, modelFailureFacts } from "@i-harness/llm-seam"
import type { LLMMessage, LLMRequest, LLMUsage, ModelClient, ToolSchema } from "@i-harness/llm-seam"
import { deriveMessages, type Session } from "@i-harness/core-session"
import { sliceMessages } from "./slices.ts"

// M33 §1.1 (⑥): imperative cheatwords. Used ONLY as a conservative flag —
// a shadow line containing one is copied into the Sensitive Instructions
// section verbatim (never interpreted, never reworded, never dropped).
// 保守：字詞匹配僅作標記，不丟原文於提示 (spec §1.1).
const SENSITIVE_MARKERS = ["修改", "改成", "不要", "必須", "禁止", "切記", "記得", "remind"] as const

// Filter length: skips bare marker words ("不要", "記得", "要不要"-type
// fragments) while keeping every substantive imperative sentence. Deliberately
// more conservative than the spec's 32-char fragment proposal — the MARKER
// match is the signal, not the length — and it never drops a real instruction.
const SENSITIVE_MIN_CHARS = 8

const CHECKPOINT_OPEN = "<compacted-summary>"
const CHECKPOINT_CLOSE = "</compacted-summary>"

// Fresh-summary wording (no prior checkpoint in the session).
const FRESH_DIRECTIVE =
  "Produce a fresh summary of this conversation. There is no prior summary to build on."

// M33 §1.2 anchored: the previous summary is injected below; the model is told
// to UPDATE rather than restate (opencode "Update the anchored summary"
// semantics — 新增內容增補、舊內容合併, not duplicated).
const ANCHORED_DIRECTIVE =
  "Update the anchored summary below: merge the conversation ABOVE into the previous summary incrementally. Keep still-true content, fold in what changed, and do not restate old content."

const SENSITIVE_GUIDANCE =
  "- [user instructions in their exact original wording — imperative user text (修改/改成/不要/必須/禁止/切記/記得/remind): copy it verbatim, do not paraphrase]"

// M33 §1.1 8-section structure (⑦ structural elements: the 7 sections wrapped
// in the <compacted-summary> checkpoint framing, IH's existing framing).
const CHECKPOINT_TEMPLATE = [
  CHECKPOINT_OPEN,
  "## Objective",
  "- [the task goal on the first compaction, or what the new span progressed]",
  "",
  "## Important Details",
  "- [facts and data that matter for correctness: exact identifiers, numbers, signatures, error strings]",
  "",
  "## Work State",
  "- Completed: [work finished across compaction rounds]",
  "- Active: [work in progress at this checkpoint]",
  "- Blocked: [stuck work and the blocker, or \"(none)\"]",
  "",
  "## Next Move",
  "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
  "",
  "## Relevant Files",
  "- [exact file paths touched in this work; preserve them verbatim]",
  "",
  "## Sensitive Instructions",
  SENSITIVE_GUIDANCE,
  "",
  "## Tool Work Summary",
  "- [tool calls: purpose and outcome, terse — not itemized]",
  "",
  CHECKPOINT_CLOSE,
].join("\n")

const RULES = [
  "Rules:",
  // M33 §1.1: tamper rule — the summarizer must never disclose the process.
  "- Do not mention the summary process — never write that the context was compacted or describe this summarization request.",
  "- Write concise engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and explicit instructions faithfully, especially corrections.",
  "- Output only the checkpoint text: do not call any tool or take any other action.",
].join("\n")

/**
 * M33 §1: build the summarizer user-message prompt.
 *
 * - 8-section template with the `<compacted-summary>` checkpoint framing
 *   (M33 §1.1, replacing the M11 8-section template).
 * - Anchored (M33 §1.2): when a previous summary is given, inject it inside a
 *   `<previous-summary>` block and use the "Update the anchored summary"
 *   directive instead of the fresh-summary wording. The prompt, not the
 *   `compaction/summary` event shape, carries the anchored semantics.
 * - Sensitive Instructions (M33 §1.1): imperative shadow lines (marker-match
 *   only) are prefilled verbatim so the model copies their original wording.
 * - `instructions` threads the manual `session-compact` command's optional
 *   user instructions (Task 4; unused callers default to undefined).
 */
export function buildSummaryPrompt(
  shadowText: string,
  previousSummary?: string,
  instructions?: string,
  // M5/D2: when the caller replays the region as REAL messages, the shadow text
  // is already in the request — embedding it again would duplicate the whole
  // conversation AND be pointless. The template still derives its sensitive-line
  // prefill from `shadowText`, so that M33 behaviour is preserved either way.
  opts?: { embedText?: boolean },
): string {
  const parts: string[] = [
    "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
    "",
    previousSummary !== undefined ? ANCHORED_DIRECTIVE : FRESH_DIRECTIVE,
    "",
    "Output EXACTLY the structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
    "",
    renderTemplate(shadowText),
    "",
    RULES,
  ]
  if (previousSummary !== undefined) {
    parts.push("", "<previous-summary>", previousSummary, "</previous-summary>")
  }
  if (instructions !== undefined && instructions.trim().length > 0) {
    parts.push("", "## User instructions (they take priority over the template):", instructions)
  }
  if (opts?.embedText ?? true) parts.push("", shadowText)
  return parts.join("\n")
}

// Render the checkpoint template with the verbatim imperative shadow lines
// prefilled into the Sensitive Instructions section.
function renderTemplate(shadowText: string): string {
  const sensitive = extractSensitiveLines(shadowText)
  if (sensitive.length === 0) return CHECKPOINT_TEMPLATE
  const placeholder = "{{SENSITIVE_PREFILL}}"
  const withPlaceholder = CHECKPOINT_TEMPLATE.replace(SENSITIVE_GUIDANCE, `${SENSITIVE_GUIDANCE}\n${placeholder}`)
  return withPlaceholder.replace(placeholder, sensitive.map((line) => `- ${line}`).join("\n"))
}

// M33 §1.1 conservative extraction: scan the shadow region, line by line; a
// line longer than the filter threshold that contains any imperative marker is
// preserved ORIGINAL (trimmed of surrounding whitespace only). No semantics
// are inferred — the marker is purely a flag (「字詞匹配僅作標記」).
function extractSensitiveLines(shadowText: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of shadowText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length < SENSITIVE_MIN_CHARS) continue
    if (!SENSITIVE_MARKERS.some((m) => line.includes(m))) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

export class SummaryCheckpointError extends Error {
  constructor(readonly failure: unknown) { super("compaction: summary checkpoint persistence failed", { cause: failure }) }
}

type SummaryBlock = "retention-policy" | "output-floor" | "fixed-input" | "call-limit" | "call-policy" | "shrink-limit" | "retention-output" | "binding" | "opaque" | "refused" | "truncated" | "incomplete"
/** Closed engine-owned reasons; provider messages never become result data. */
export class SummaryBlockedError extends Error {
  constructor(kind: SummaryBlock, facts: { chars?: number; floor?: number; input?: number; output?: number; window?: number; limit?: number } = {}) {
    const numeric = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? String(value) : "unknown"
    const reasons: Record<SummaryBlock, string> = {
      "retention-policy": `compaction: retained checkpoint ceiling ${numeric(facts.chars)} chars is below quality floor ${numeric(facts.floor)}`,
      "output-floor": `compaction: summary output ceiling ${numeric(facts.output)} cannot provide reasoning/retention allowance ${numeric(facts.floor)}`,
      "fixed-input": `compaction: indivisible/fixed summary input cannot fit (${numeric(facts.input)} input tokens; ${numeric(facts.output)} required output; window ${numeric(facts.window)})`,
      "call-limit": `compaction: shared summary call limit exhausted (${numeric(facts.limit)})`,
      "call-policy": "compaction: maxSummaryCalls must be an integer in [1, 8]",
      "shrink-limit": "compaction: summary overflow shrink limit exhausted (2)",
      "retention-output": `compaction: retained summary outside quality/size limits (${numeric(facts.chars)} chars; floor ${numeric(facts.floor)}; ceiling ${numeric(facts.limit)})`,
      binding: "compaction: summary binding does not match prepared model",
      opaque: "compaction: summary fixed input contains unpriced provider references",
      refused: "compaction: the provider refused to produce a summary",
      truncated: "compaction: provider truncated the summary; checkpoint was not committed",
      incomplete: "compaction: incomplete summary stream; checkpoint was not committed",
    }
    super(reasons[kind])
  }
}

interface SummaryLimits {
  maxOutputTokens?: number
  outputCapExplicit?: boolean
  contextWindow?: number
  modelMaxOutputTokens?: number
  overheadTokens?: number // compatibility: actual prepared system/tools are priced instead
  reasoningEffort?: LLMRequest["reasoningEffort"]
  metadata?: import("@i-harness/core-session").ContextBindingMetadata
  signal?: AbortSignal
  maxSummaryCalls?: number
  beforeTransport?: () => Promise<void>
  validateBeforeTransport?: () => void
  onMeasurement?: (facts: { inputTokens: number; contextWindow?: number; outputReserve: number; effectiveCap?: number; capSupport: string; minimumCap: number; reasoningBudget?: number; defaultFloorAdjusted: boolean; coverage: string; estimateSource: "projected-heuristic"; uncertainties: readonly string[] }) => void
  onUsage?: (usage: LLMUsage) => void
}

function confirmedOverflow(error: unknown): boolean {
  if (modelFailureFacts(error)?.code !== "CONTEXT_WINDOW_EXCEEDED") return false
  let current = error
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const record = current as { code?: string; modelFailure?: { code?: string }; cause?: unknown }
    if (record.code === "CONTEXT_WINDOW_EXCEEDED" || record.modelFailure?.code === "CONTEXT_WINDOW_EXCEEDED") return true
    current = record.cause
  }
  return false
}

/** Independent prepared summary admission. All physical calls share one bound. */
export async function summarizeWithModel(
  model: ModelClient, replayText: string, maxTokens: number,
  previousSummary?: string, instructions?: string, minSummaryChars = 500,
  attemptsTracker?: { count: number },
  prefix?: { systemPrompt: string; tools: ToolSchema[]; messages: LLMMessage[] },
  limits: SummaryLimits = {}, region?: { session: Session; shadowedSeqs: number[] },
): Promise<{ text: string; attempts: number }> {
  if (maxTokens * 4 < minSummaryChars) throw new SummaryBlockedError("retention-policy", { chars: maxTokens * 4, floor: minSummaryChars })
  const maximum = limits.maxSummaryCalls ?? 8
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8) throw new SummaryBlockedError("call-policy")
  const tracker = attemptsTracker ?? { count: 0 }
  let attempts = 0, running = previousSummary
  const check = () => { limits.signal?.throwIfAborted(); limits.validateBeforeTransport?.() }
  // Distinct summary bindings receive a text projection. Preserve semantic
  // tool work and image descriptors without replaying another model's signed
  // continuation, signatures or base64 payload as ordinary user text.
  const textOf = (messages: LLMMessage[]) => messages.map(message => {
    const content = typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : `[image: ${part.image.mediaType}, ${Math.ceil(part.image.dataBase64.length * 3 / 4)} bytes]`).join("\n")
    const calls = message.role === "assistant" ? (message.toolCalls ?? []).map(call => `tool ${call.name} (${call.id}): ${JSON.stringify(call.args)}`).join("\n") : ""
    return `[${message.role}]\n${content}${calls ? `\n${calls}` : ""}`
  }).join("\n")
  type Piece = { messages: LLMMessage[]; text: string; shrinks: number; standalone?: true; rejectedTokens?: number }
  let whole = prefix?.messages ?? []
  if (!prefix && region) {
    // Distinct text splits must incorporate the same selected events/anchor
    // that the commit will replace, never a broader historical prefix. Keep
    // invisible substitutions and admissions needed to materialize their data.
    const selected = new Set(region.shadowedSeqs)
    try { whole = deriveMessages({ ...region.session, events: region.session.events.filter(event =>
      event.type === "compaction/prune" || event.type === "agent/input/admitted" || event.seq !== undefined && selected.has(event.seq)) }) }
    catch { whole = [{ role: "user", content: replayText }] } // malformed legacy images remain descriptor text
  }
  const pending: Piece[] = [{ messages: whole, text: replayText, shrinks: 0 }]
  let lastLength = 0
  while (pending.length) {
    const piece = pending[0]!
    let accepted = false
    for (let qualityRound = 0; qualityRound < 2; qualityRound++) {
      check()
      const directive = buildSummaryPrompt(piece.text, running, instructions, { embedText: prefix === undefined })
        + `\nRetained checkpoint must be between ${minSummaryChars} and ${maxTokens * 4} characters. Preserve the objective, authority, instructions and completed outcomes within that limit.`
        + (qualityRound ? "\nThe previous output did not meet the retained checkpoint limits. Produce a complete shorter checkpoint within those limits." : "")
      // A later autonomous tool round can be summarized independently once all
      // preceding calls have results. Keep its native assistant/result payload
      // intact and open a legal standalone conversation. The rolling checkpoint
      // in directive carries the original task/authority from preceding pieces.
      const opener: LLMMessage[] = prefix && piece.standalone && piece.messages[0]?.role === "assistant"
        ? [{ role: "user", content: "Summarize the following recorded conversation continuation. Preserve its completed outcomes under the task and authority in the checkpoint." }] : []
      const request: LLMRequest = { systemPrompt: prefix?.systemPrompt ?? "", tools: prefix?.tools ?? [],
        messages: [...opener, ...(prefix ? piece.messages : []), { role: "user", content: directive }], promptCache: { mode: "off" },
        ...(limits.reasoningEffort !== undefined ? { reasoningEffort: limits.reasoningEffort } : {}), ...(limits.signal ? { signal: limits.signal } : {}) }
      // Capture pure uncapped facts first: reasoning floors can exceed the preferred
      // default. Only a derivative of this captured payload is allowed to execute.
      const prepared = await prepareModelRequest(model, request)
      check()
      const { input, output } = prepared.measurement
      if (limits.metadata && input.coverage !== "neutral-only" && (input.modelId !== limits.metadata.modelId || input.protocol !== limits.metadata.protocol)) throw new SummaryBlockedError("binding")
      if (input.coverage === "incomplete") throw new SummaryBlockedError("opaque")
      const inputTokens = Object.values(input.components).reduce((sum, component) => sum + component.heuristicTokens, 0)
      const preferred = limits.maxOutputTokens ?? 4096
      const explicit = limits.outputCapExplicit ?? limits.maxOutputTokens !== undefined
      const required = output.minimumCap > preferred && output.reasoningBudget !== undefined ? Math.max(output.minimumCap, output.reasoningBudget + maxTokens) : output.minimumCap
      let ceiling = explicit ? preferred : Math.max(preferred, required)
      if (limits.modelMaxOutputTokens !== undefined) ceiling = Math.min(ceiling, limits.modelMaxOutputTokens)
      if (ceiling < required) throw new SummaryBlockedError("output-floor", { output: ceiling, floor: required })
      const room = limits.contextWindow === undefined ? undefined : limits.contextWindow - inputTokens - Math.ceil(limits.contextWindow * .05)
      // Smaller descendants must show reduction on the actual provider projection,
      // so fixed raw overrides cannot manufacture progress from neutral slicing.
      const reduced = piece.rejectedTokens === undefined || inputTokens < piece.rejectedTokens
      const requiredRoom = output.capSupport === "unsupported" ? ceiling : required
      if (!reduced || room !== undefined && room < requiredRoom) {
        const segments = sliceMessages(piece.messages, 1, true)
        if (!reduced || segments.length < 2) throw new SummaryBlockedError("fixed-input", { input: inputTokens, output: requiredRoom, window: limits.contextWindow })
        const split = Math.ceil(segments.length / 2)
        const chunks = [segments.slice(0, split).flat(), segments.slice(split).flat()]
        pending.splice(0, 1, ...chunks.map(messages => ({ messages, text: textOf(messages), shrinks: piece.shrinks, standalone: true as const, rejectedTokens: inputTokens })))
        accepted = true // resliced; no work consumed and no transport made
        break
      }
      const cap = output.capSupport === "unsupported" || room === undefined ? ceiling : Math.min(ceiling, room)
      const candidate = output.capSupport === "unsupported" ? prepared : prepared.withOutputCap(cap)
      const effective = candidate.measurement.output.effectiveCap
      limits.onMeasurement?.({ inputTokens, contextWindow: limits.contextWindow, outputReserve: cap,
        ...(output.capSupport === "supported" && effective !== undefined ? { effectiveCap: effective } : {}), capSupport: output.capSupport, minimumCap: output.minimumCap,
        reasoningBudget: output.reasoningBudget, defaultFloorAdjusted: !explicit && ceiling > preferred, coverage: input.coverage, estimateSource: "projected-heuristic", uncertainties: input.uncertainties })
      if (tracker.count >= maximum) throw new SummaryBlockedError("call-limit", { limit: maximum })
      if (limits.beforeTransport) {
        try { await limits.beforeTransport() } catch (error) { throw new SummaryCheckpointError(error) }
      }
      check()
      attempts++; tracker.count++
      let out = "", ended = false, refused = false, truncated = false
      const usage: LLMUsage = {}
      try {
        for await (const event of candidate.stream({ signal: limits.signal, validateBeforeTransport: check })) {
          limits.signal?.throwIfAborted()
          if (event.type === "text/chunk") out += event.text
          else if (event.type === "error") throw event.error
          else if (event.type === "usage") {
            for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
              const value = event.usage[field]
              if (typeof value === "number" && Number.isFinite(value)) usage[field] = value
            }
            if (event.usage.inputTokenSemantics === "includes-cache" || event.usage.inputTokenSemantics === "excludes-cache") usage.inputTokenSemantics = event.usage.inputTokenSemantics
          }
          else if (event.type === "end") { ended = true; refused = event.refused === true; truncated = event.truncated === true; break }
        }
      } catch (error) {
        limits.signal?.throwIfAborted()
        if (!confirmedOverflow(error)) throw error
        check()
        if (piece.shrinks >= 2) throw new SummaryBlockedError("shrink-limit")
        const segments = sliceMessages(piece.messages, 1, true)
        if (segments.length < 2) throw new SummaryBlockedError("fixed-input", { input: inputTokens, output: requiredRoom, window: limits.contextWindow })
        const split = Math.ceil(segments.length / 2)
        pending.splice(0, 1, ...[segments.slice(0, split).flat(), segments.slice(split).flat()].map(messages => ({ messages, text: textOf(messages), shrinks: piece.shrinks + 1, standalone: true as const, rejectedTokens: inputTokens })))
        accepted = true
        break
      }
      if (Object.keys(usage).length) limits.onUsage?.(usage)
      check()
      if (refused) throw new SummaryBlockedError("refused")
      if (truncated) throw new SummaryBlockedError("truncated")
      if (!ended) throw new SummaryBlockedError("incomplete")
      const trimmed = out.trim()
      if (!trimmed) throw new Error("compaction: summarizer returned empty output")
      lastLength = trimmed.length
      if (trimmed.length < minSummaryChars || trimmed.length > maxTokens * 4) continue
      // No lossy slice. Every accepted piece is a complete retained checkpoint.
      running = trimmed; pending.shift(); accepted = true; break
    }
    if (!accepted) throw new SummaryBlockedError("retention-output", { chars: lastLength, floor: minSummaryChars, limit: maxTokens * 4 })
  }
  check()
  if (running === undefined || running.length < minSummaryChars || running.length > maxTokens * 4) throw new Error("compaction: final retained checkpoint is invalid")
  return { text: running, attempts }
}

import { clampOutputCap } from "@i-harness/llm-seam"
import type { LLMMessage, LLMRequest, ModelClient, ToolSchema } from "@i-harness/llm-seam"
import { estimateContent } from "@i-harness/token-meter"
import type { Session } from "@i-harness/core-session"
import { approxTokens } from "./tokens.ts"
import { sliceRegion } from "./slices.ts"

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

function trimToTokens(text: string, maxTokens: number): string {
  return text.slice(0, maxTokens * 4)
}

/**
 * Summarize with a retry guard against degenerate output.
 *
 * M34 ⑦c: `minSummaryChars` (default 500) is the quality floor — a trimmed
 * output SHORTER than the floor counts as a failed attempt (not a valid
 * summary): ONE same-model retry is made, then the attempt throws (the
 * engine's fail-soft path swallows it unchanged — no new error type). The
 * empty-output case keeps its immediate throw (pre-M34 semantics). The
 * maxTokens truncation happens AFTER the floor check, on the accepted output.
 * `attempts` reports how many model calls the pass took (the engine feeds it
 * into the compaction/attempt analytics event).
 *
 * M75: when the single prefix-shaped request CANNOT FIT the window, and the
 * caller hands the region in, the pass summarises that region in chained
 * pieces instead of sending the one impossible request — the one a strict
 * provider rejects with a NON-retryable validation error, whose fail-soft arm
 * is the reset that throws the inherited context away. The fit predicate and
 * the piece loop live HERE, beside the clamp they must agree with: both
 * evaluate `priceInput` below, so the two can never drift. No cap, no window,
 * no prefix or no region ⇒ the single path, byte for byte as before.
 */
export async function summarizeWithModel(
  model: ModelClient,
  replayText: string,
  maxTokens: number,
  previousSummary?: string,
  instructions?: string,
  minSummaryChars = 500,
  attemptsTracker?: { count: number }, // optional: model-call count even when the pass throws
  // M5/D2: the shape the main loop sends. Present → this request is a byte-prefix
  // of the last main request, so the provider's cache can serve the whole
  // conversation instead of charging full price for it. Absent → the legacy
  // single-message text form, unchanged.
  prefix?: { systemPrompt: string; tools: ToolSchema[]; messages: LLMMessage[] },
  /** M73: the request's OWN budget. `maxOutputTokens` is the model's resolved
   * cap (the chain's value, anthropic's required fallback included);
   * `contextWindow` is what the engine resolved; `overheadTokens` is the
   * host-known charge the session log does not carry (system prompt + tool
   * schemas) that the clamp must add to the input it prices. All optional —
   * absent means the request carries no cap, exactly as before.
   *
   * NOT `CompactionConfig.maxTokens`, which stays the 3rd argument and keeps
   * its meaning: a post-hoc CHARACTER slice of the accepted summary
   * (`trimToTokens` = `slice(0, maxTokens * 4)`, ~4 096 chars at the default
   * 1024). Wiring THAT to the wire would cut the summary off mid-sentence and
   * the truncated text still clears `minSummaryChars`, so the next round's
   * anchored summary would be built on the stump. This one is a token ceiling
   * on the request; the two are different quantities and different arguments. */
  limits?: { maxOutputTokens?: number; contextWindow?: number; overheadTokens?: number },
  /** M75: the region this call is summarising — the session and the seqs the
   * caller would have shadowed, handed in RAW and un-sliced. The decision to
   * slice is taken here, by the very expression the clamp below is fed, so the
   * predicate can never drift from the clamp's own arithmetic: a caller-side
   * `priceInput(prefix.messages)` would leave out the directive and the
   * overhead the clamp charges, and the band where the region alone fits but
   * the request does not would keep taking the single-call path into a
   * provider rejection. Read only when `prefix` and both `limits` numbers are
   * present; otherwise the single path runs, byte for byte unchanged. */
  region?: { session: Session; shadowedSeqs: number[] },
): Promise<{ text: string; attempts: number }> {
  let attempts = 0
  const attemptsTrackerOut = attemptsTracker ?? { count: 0 }

  // M75: the ONE input-price arithmetic — what the cap is clamped against
  // (M73) and what decides "the single request cannot fit" (M75). They are the
  // same quantity by construction: `clampOutputCap` returns the cap UNTOUCHED
  // exactly when `contextWindow − this` is not `>= 1` (llm-seam:462-463), which
  // is exactly when a strict provider rejects `input + max_tokens > context`
  // (a validation error, and NOT in the retryable set).
  //
  // The price is the way the session's own clamp prices it (core-agent:
  // `estimateContent(messages) + overheadTokens`): this request really does
  // carry `prefix.systemPrompt` and `prefix.tools`, which the session log does
  // not, so charging the messages alone would under-price the input and make
  // the room the clamp promises too generous — the exact overrun the clamp
  // exists to prevent. `?? 0` for a caller that hands no overhead; the engine
  // always resolves a number.
  //
  // The overhead is charged ONLY when the request really carries the pair it
  // stands for. On the legacy text path (`prefix` undefined) the request has
  // neither system prompt nor tools, so charging it over-prices the input — and
  // when the charge alone fills the window, `hardRoom < 1` trips the clamp's
  // "the input already fills the window" arm and the RAW cap leaves (that
  // defect survives on that route: reachable with a configured
  // `summarizationModel`, or an engine built without `requestShape`).
  const priceInput = (messages: LLMMessage[]): number =>
    estimateContent(messages) + (prefix === undefined ? 0 : (limits?.overheadTokens ?? 0))

  /** One model call, with the M34 ⑦c retry guard. `messages` is the
   * conversation this request carries: [] on the legacy text path (the
   * directive embeds the replay text instead), the region fold on the single
   * prefix call, one piece on the chained path. `previous` anchors this call's
   * directive; `enforceFloor` is the quality floor — see the M75 §1.5 note at
   * the check. */
  const callModel = async (messages: LLMMessage[], previous: string | undefined, enforceFloor: boolean): Promise<string> => {
    let lastLength = 0
    for (let round = 0; round < 2; round++) {
      attempts += 1
      attemptsTrackerOut.count += 1
      const directive = buildSummaryPrompt(replayText, previous, instructions, { embedText: prefix === undefined })
      const request: LLMRequest =
        prefix === undefined
          ? { messages: [{ role: "user", content: directive }], tools: [], systemPrompt: "" }
          : { messages: [...messages, { role: "user", content: directive }], tools: prefix.tools, systemPrompt: prefix.systemPrompt }
      // M73: the cap this request carries, clamped against the window and the
      // input we are about to send — the same `clampOutputCap` the session's
      // own requests go through (llm-seam), applied HERE because this request
      // is built here and nowhere else. Absent cap ⇒ absent key: a default
      // would be a number nobody chose. The input is priced by the SAME
      // `priceInput` the M75 fit predicate uses (see its note above).
      const cappedRequest: LLMRequest = limits?.maxOutputTokens === undefined
        ? request
        : { ...request, maxOutputTokens: clampOutputCap(limits.maxOutputTokens, limits.contextWindow, priceInput(request.messages)) }
      let out = ""
      // M77: per-call, so a refusal cannot leak into the next round's message.
      let refused = false
      for await (const ev of model.stream(cappedRequest)) {
        if (ev.type === "text/chunk") out += ev.text
        else if (ev.type === "error") throw ev.error
        else if (ev.type === "end") {
          if (ev.refused === true) refused = true
          break
        }
      }
      const trimmed = out.trim()
      // M77: an empty output has two causes, and the message may not merge them.
      // A provider REFUSAL (HTTP 200, no content, `end.refused`) reported as
      // "summarizer returned empty output" blames this pass for a decision the
      // provider made — the engine's fail-soft warn quotes this text verbatim.
      // Absent stays absent: without the bit the message is byte-identical.
      if (trimmed.length === 0) {
        throw new Error(refused
          ? "compaction: the provider refused to produce a summary"
          : "compaction: summarizer returned empty output")
      }
      lastLength = trimmed.length
      // M75 §1.5: the floor guards the text the SESSION ends up with, so it is
      // enforced only where this call's output IS that text — the single call,
      // or the LAST piece of a chain. Per-piece enforcement would be wrong: a
      // legitimate intermediate merge can be short (that piece had little to
      // fold in), and failing it would throw away a chain that was working.
      // BLIND SPOT, named: a chain that is muddled in the middle but long
      // enough at the end is not caught — the same blind spot today's single
      // call has when it lands just above the floor.
      if (enforceFloor && trimmed.length < minSummaryChars) continue // degenerate → one retry
      return approxTokens(trimmed) > maxTokens ? trimToTokens(trimmed, maxTokens) : trimmed
    }
    throw new Error(`compaction: summarizer output below minSummaryChars (${lastLength} < ${minSummaryChars})`)
  }

  // M75: the fallback gate. The single prefix-shaped request is the fast path —
  // it is a byte prefix of the session's last main request and the provider
  // cache serves it. It stops being possible exactly when the REQUEST fills the
  // window — the region fold PLUS the directive PLUS the overhead the clamp
  // charges (clampOutputCap's arm C returns the raw cap; a strict provider
  // rejects `input + max_tokens > context`). The predicate below is that
  // quantity and not the region alone, because the two are not the same
  // question: a region that fits can still carry a request that does not, and
  // that band is exactly where a region-priced gate would send the impossible
  // call. THEN — and only then — the pass summarises the region in pieces:
  // pieces 2..N are cold reads (this tree sends no cache breakpoints), which is
  // strictly better than today's outcome there: no summary at all and the
  // context thrown away by a reset.
  //
  // All four entry conditions are deliberately required: no cap or no window ⇒
  // the clamp never runs, so there is no "does not fit" question to answer and
  // the single path stays byte-identical (as do the callers that never had a
  // budget); no prefix ⇒ the request is the legacy text form, which carries no
  // piece messages; no region ⇒ nothing to slice.
  if (
    region !== undefined &&
    prefix !== undefined &&
    limits !== undefined &&
    limits.maxOutputTokens !== undefined &&
    limits.contextWindow !== undefined
  ) {
    const contextWindow = limits.contextWindow
    const singleDirective = buildSummaryPrompt(replayText, previousSummary, instructions, { embedText: false })
    // The single request's own price — the SAME expression the clamp is fed,
    // region fold PLUS directive PLUS overhead, priced as one request.
    const singlePrice = priceInput([...prefix.messages, { role: "user", content: singleDirective }])
    if (!(contextWindow - singlePrice >= 1)) {
      // The per-piece budget: the window minus everything a piece request
      // carries BESIDES the piece — the overhead, the directive priced in its
      // WORST case, and one output allowance. The directive's worst case is the
      // chain's own anchor ceiling: a running summary is `maxTokens * 4` chars
      // at most (`trimToTokens` caps the accepted text there), and never
      // shorter than the caller's existing anchor. The output allowance is
      // `maxTokens` — the size the accepted summary is capped to, and therefore
      // also the bound just used. Measured, 12-turn fixture, window 1 000,
      // maxTokens 200, no overhead: directive allowance 684, budget 116 → 12
      // pieces of one turn each (175/196 tokens), every piece request 624..838
      // tokens — all of them legal on that window, where the single call priced
      // 2 591. A piece with no interior cut is emitted over budget by
      // `sliceRegion`'s own contract; if even that does not fit, the call
      // throws and the caller's fail-soft arm answers exactly as it does today.
      const runningChars = Math.max(previousSummary?.length ?? 0, maxTokens * 4)
      const allowance = priceInput([
        { role: "user", content: buildSummaryPrompt(replayText, "x".repeat(runningChars), instructions, { embedText: false }) },
      ])
      const pieces = sliceRegion(region.session, region.shadowedSeqs, Math.max(1, contextWindow - allowance - maxTokens))
      if (pieces.length > 0) {
        // Chained: piece k>1 receives what piece k-1 produced as its anchor —
        // "merge the conversation ABOVE into the previous summary" is what the
        // prompt already asks for. The running text lives in MEMORY only:
        // nothing is appended mid-pass; the caller appends the ONE
        // `compaction/summary` for the whole region once this returns, and a
        // throw here leaves the log untouched (fail-soft upstream).
        let running = previousSummary
        let text = ""
        for (let k = 0; k < pieces.length; k++) {
          text = await callModel(pieces[k]!, running, k === pieces.length - 1)
          running = text
        }
        return { text, attempts }
      }
      // An empty region: nothing to slice and nothing to summarise — fall
      // through to the single call, which fails exactly as it does today.
    }
  }
  return { text: await callModel(prefix === undefined ? [] : prefix.messages, previousSummary, true), attempts }
}

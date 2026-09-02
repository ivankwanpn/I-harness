import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { approxTokens } from "./tokens.ts"

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
  parts.push("", shadowText)
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
 */
export async function summarizeWithModel(
  model: ModelClient,
  replayText: string,
  maxTokens: number,
  previousSummary?: string,
  instructions?: string,
  minSummaryChars = 500,
  attemptsTracker?: { count: number }, // optional: model-call count even when the pass throws
): Promise<{ text: string; attempts: number }> {
  let attempts = 0
  let lastLength = 0
  const attemptsTrackerOut = attemptsTracker ?? { count: 0 }
  for (let round = 0; round < 2; round++) {
    attempts += 1
    attemptsTrackerOut.count += 1
    const request: LLMRequest = {
      messages: [{ role: "user", content: buildSummaryPrompt(replayText, previousSummary, instructions) }],
      tools: [],
      systemPrompt: "",
    }
    let out = ""
    for await (const ev of model.stream(request)) {
      if (ev.type === "text/chunk") out += ev.text
      else if (ev.type === "error") throw ev.error
      else if (ev.type === "end") break
    }
    const trimmed = out.trim()
    if (trimmed.length === 0) throw new Error("compaction: summarizer returned empty output")
    lastLength = trimmed.length
    if (trimmed.length < minSummaryChars) continue // degenerate → one retry
    return {
      text: approxTokens(trimmed) > maxTokens ? trimToTokens(trimmed, maxTokens) : trimmed,
      attempts,
    }
  }
  throw new Error(`compaction: summarizer output below minSummaryChars (${lastLength} < ${minSummaryChars})`)
}

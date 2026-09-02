import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { approxTokens } from "./tokens.ts"

const COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  "Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
  "",
  "## Primary Request and Intent",
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  "",
  "## Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "## Files and Code",
  "- [exact path: why it matters, key changes or snippets]",
  "",
  "## Errors and Fixes",
  "- [error: how it was resolved, plus any related user feedback]",
  "",
  "## Pending Jobs",
  "- [explicitly requested work not yet completed]",
  "",
  "## Current Work",
  "- [precisely what was in progress at this checkpoint]",
  "",
  "## Next Step",
  "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
  "",
  "## Critical Context",
  "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
].join("\n")

function trimToTokens(text: string, maxTokens: number): string {
  return text.slice(0, maxTokens * 4)
}

export async function summarizeWithModel(
  model: ModelClient,
  replayText: string,
  maxTokens: number,
  instructions?: string,
): Promise<string> {
  // M33 §5: manual session-compact instruction threading — the caller's
  // instructions enter the prompt as their own section. Absent (undefined) →
  // byte-identical pre-M33 prompt (the auto path passes none).
  // NOTE (G1 merge seam): group-1's buildSummaryPrompt(shadowText,
  // previousSummary?, instructions?) re-places this prompt; the parameter
  // signature here is the single merge point.
  const prompt = instructions === undefined || instructions.length === 0
    ? `${COMPACTION_INSTRUCTION}\n\n${replayText}`
    : `${COMPACTION_INSTRUCTION}\n\n## User instructions\n${instructions}\n\n${replayText}`
  const request: LLMRequest = {
    messages: [{ role: "user", content: prompt }],
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
  return approxTokens(trimmed) > maxTokens ? trimToTokens(trimmed, maxTokens) : trimmed
}

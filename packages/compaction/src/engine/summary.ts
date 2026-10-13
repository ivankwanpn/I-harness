import type { Session } from "@i-harness/core-session"
import { deriveMessagesUpTo } from "@i-harness/core-session"
import type { LLMMessage, ToolSchema } from "@i-harness/llm-seam"
import { summarizeWithModel } from "../summarizer.ts"
import { lastSummaryText } from "../projection/shadowed.ts"
import type { SummaryDependencies, CompactSettings } from "./contracts.ts"

// Preparation intentionally stays outside the pass's summarizer catch.
export function prepareSummary(session: Session, shadowedSeqs: number[], config: CompactSettings, deps: Pick<SummaryDependencies, "model" | "requestShape">) {
  // R-B2: a CONFIGURED summarization model WINS over `deps.model` — deliberate,
  // not the silent exception this unit exists to remove. `deps.model` is the
  // session assembly's stable model handle (R-B1), so every HANDLE-REACHABLE
  // holder follows a rebind; this one does not, because a rebind must not
  // silently discard the user's explicit summarization choice. Its twin: the
  // guardian's `guardian.model` (reviewer.ts, `deps.model ?? deps.parentModel`)
  // — "configured" names TWO exceptions, never one. Cost, for both, after a
  // rebind: each summary / review keeps billing the configured endpoint.
  // Pinned by "a CONFIGURED summarization model wins over the handle" in
  // packages/session-executor/test/assembly.test.ts — do NOT "fix" this
  // into following the handle.
  const model = config.summarizationModel ?? deps.model
  // M5/D2: replay the region as REAL messages so this call is a byte-prefix of
  // the last main request. Only when the summarizer is the same model — a
  // configured `summarizationModel` has its own cache key, so replaying would
  // buy nothing and cost tokens for nothing. The region is everything the
  // shadow markers name, and it is a prefix of the log by construction, so
  // deriveMessagesUpTo over its last seq is exactly the main path's fold.
  const shape = config.summarizationModel === undefined ? deps.requestShape?.() : undefined
  let prefix: { systemPrompt: string; tools: ToolSchema[]; messages: LLMMessage[] } | undefined
  if (shape !== undefined) {
    let lastShadowed = -1
    for (const seq of shadowedSeqs) if (seq > lastShadowed) lastShadowed = seq
    prefix = { systemPrompt: shape.systemPrompt, tools: shape.tools, messages: deriveMessagesUpTo(session, lastShadowed) }
  }
  // M33 §1.2 anchored: scan the session for the LAST `compaction/summary`
  // before building the prompt. If one exists, its text is injected via
  // `<previous-summary>` and the summarizer is told to UPDATE it — the
  // anchored semantics are prompt-only; the `compaction/summary` event shape
  // is unchanged (each round still appends its own summary event).
  const previousSummary = lastSummaryText(session)
  return { model, prefix, previousSummary }
}

// Return the original promise directly. The commit owner retains the only
// await, its error disposition, and every projection marker append.
export function requestSummary(
  session: Session, shadowedSeqs: number[], replayText: string,
  prepared: ReturnType<typeof prepareSummary>, config: CompactSettings,
  contextWindow: number, deps: Pick<SummaryDependencies, "maxOutputTokens" | "telemetry">,
  overheadNow: () => number, attemptsTracker: { count: number }, instructions?: string,
) {
  const { model, prefix, previousSummary } = prepared
  // M73: the 9th argument is the request's OWN budget — both halves spread
  // conditionally, so "absent" stays absent at every hop (a default here
  // would be a number nobody chose). `config.maxTokens` keeps its position
  // as the 3rd argument: it is still only the post-hoc character slice.
  // The CAP follows the SHAPE's gate (`summarizationModel === undefined`
  // above): a configured summarization model is a different endpoint, so
  // `deps.maxOutputTokens` — the session model's resolved cap — was never
  // resolved for the one receiving this request. The guardian's twin says
  // what to do with it (reviewer.ts: "a wrong number … is worse than an
  // absent one").
  return summarizeWithModel(model, replayText, config.maxTokens, previousSummary, instructions, config.minSummaryChars, attemptsTracker, prefix, {
    ...(config.summarizationModel === undefined && deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    // The host-known charge the session log does not carry — the SAME one
    // the session's own clamp adds to its input price (core-agent:
    // `estimateContent(messages) + overheadTokens`). The summarizer's
    // request carries the system prompt and tool schemas too. Resolved
    // (default 0), so it is passed as a value, not as a spread.
    overheadTokens: overheadNow(),
    onUsage: usage => { deps.telemetry?.emit({ type: "compaction/usage", ts: Date.now(), data: { ...usage } }) },
  },
  // M75: and the region itself, RAW — the summarizer slices it for itself
  // when the single request cannot fit the window. Pre-slicing here would
  // move the fit predicate to this side of the seam, where the clamp's own
  // arithmetic (which prices the directive and the overhead too) is not.
  { session, shadowedSeqs })
}

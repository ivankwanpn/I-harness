import { resetWindowOnce } from "./projection/window.ts"
import type { SessionView as Session, ContextBindingMetadata } from "@i-harness/core-session"
import type { ModelClient, ToolSchema, ReasoningEffort } from "@i-harness/llm-seam"
import type { ProviderProfile } from "@i-harness/provider"
import type { Telemetry } from "@i-harness/telemetry"
import { resolveCompactSpec, resolveContextWindow, type CompactionConfig } from "./config.ts"
import { activeTokens } from "./tokens.ts"

import { createAdmission } from "./engine/admission.ts"
import { runCompactionPass } from "./engine/commit.ts"

export { approxTokens, activeTokens, IMAGE_TOKEN_ESTIMATE } from "./tokens.ts"
export { selectShadowableRange } from "./region.ts"
export { resolveConfig, resolveCompactSpec, resolveContextWindow } from "./config.ts"
export type { CompactionConfig, CompactionRequest, ModelCompactionPolicy, PruneConfig, ResolvedCompactionConfig, ResolvedPruneConfig } from "./config.ts"

export interface CompactionResult {
  compacted: boolean
  // For compact(): the seqs shadowed behind the appended summary. For a pure
  // reset (reset:true): the removedSeqs recorded on the compaction/reset
  // marker (identical shadow semantics — deriveMessages hides them). For a
  // prune-only pass (pruned:true): nothing was shadowed → [].
  shadowedSeqs: number[]
  summary?: string
  reset?: boolean // M20: true only for a pure resetWindow (no summary)
  // M33: true when a `compaction/prune` marker was appended in this pass (the
  // model surface / summarizer input now carries substitutes). A prune-only
  // pass also reports `compacted:true` (pressure resolved without an LLM call).
  pruned?: boolean
  /** M73: WHY a pass that did not compact did not. `compacted:false` has EIGHT
   * producers at this revision — compactOnce's no-shadowable-region arm and
   * its summarizer failure, maybeCompact's five gates (pressure, sticky,
   * re-fire, hysteresis, breaker), and resetWindow's `reset: false` — and
   * before this field they were indistinguishable to every consumer: the CLI
   * reported the summarizer's failure as "nothing to compact". Only the
   * summarizer failure names a reason, because it is the only arm that can be
   * a real FAILURE; the other seven mean "nothing to do" and stay absent
   * (pre-M73 behavior, unchanged). */
  reason?: "summarizer-failed" | 'replacement-history-unsupported'
  /** Safe engine-owned policy/admission failure, never a provider response body. */
  blockedReason?: string
}

export interface CompactionRunOptions {
  signal?: AbortSignal
  protectedSeqs?: readonly number[]
  reason?: "auto" | "manual" | "recovery"
  maxSummaryCalls?: number
}

export interface CompactionEngine {
  maybeCompact(session: Session, options?: CompactionRunOptions): Promise<CompactionResult>
  // M33 §5: `instructions` is the manual session-compact surface — threaded
  // into the summarizer prompt as a "User instructions" section. Optional and
  // additive: absent → pre-M33 behavior; the auto path never passes one.
  compact(session: Session, instructions?: string, options?: CompactionRunOptions): Promise<CompactionResult>
  recover(session: Session, options?: CompactionRunOptions): Promise<CompactionResult>
  // Legacy explicit append-only tail reset. Automatic/forced recovery never
  // calls this: protected task/authority/outcomes require a valid checkpoint.
  resetWindow(session: Session, retainLast: number): Promise<CompactionResult>
}

export function createCompactionEngine(deps: {
  facts?: () => import('@i-harness/core-session').LegacyCompactionFacts<import('@i-harness/core-session').ProducerFactOutcome>
  model: ModelClient
  config: CompactionConfig
  profile?: ProviderProfile // M15: optional context catalog
  modelId?: string          // M15: the resolved model id for catalog lookup
  provider?: string         // M34 ⑦a: the policy-key provider namespace ("provider/model")
  telemetry?: Telemetry     // M34 ⑦b: optional host stream (M25 convention — absent = zero events)
  /** M5/D2: the shape the main loop sends, read AT COMPACT TIME rather than
   * whatever was true at construction. Present → the summarizer replays the
   * region as REAL messages, so its request is a LEADING SLICE of the fold the
   * main path would send at that moment, byte for byte up to the region's
   * block-aligned cut. M78 holds that identity across a prune, and it is the
   * POST-MARKER fold that the prefix matches: the `compaction/prune` marker is
   * on the log before this fold is taken and the seq filter keeps it visible, so
   * prefix and main fold substitute the same old tool output. The move ALONE
   * would break exactly this — the marker lands past the region's cut, and the
   * prefix shows the RAW output where the main fold shows the substitute.
   * Absent → the legacy text form, unchanged: without the shape the bytes cannot
   * match, so there is no reuse to lose.
   *
   * It is NOT a byte-prefix of the LAST SENT main request any more, and the
   * cache side is a trade this unit did not measure — stated, not repaired.
   * Pre-M78, at the moment of the pass, the replayed messages WERE
   * byte-identical to that last request (the marker that changes the fold is
   * appended only after the attempt), so the provider's automatic prefix cache
   * could serve them at the cached-read price. Post-M78 the replayed prefix
   * diverges from that cached content at the first newly-pruned output:
   * everything after it is billed at the full rate, while the pruned bytes are
   * not sent at all. Which side wins depends on the cache discount and on where
   * the pruned output sits. */
  requestShape?: () => { systemPrompt: string; tools: ToolSchema[] }
  /** Main binding's known output limit. Only inherited summaries use this as
   * a hard model upper bound; their preferred wire cap is independently4096. */
  maxOutputTokens?: number
  budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding
  contextMetadata?: ContextBindingMetadata
  reasoningEffort?: ReasoningEffort
  /** Explicit summary metadata/effort belong to the distinct summary client. */
  summaryBudgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding
  summaryMetadata?: ContextBindingMetadata
  summaryReasoningEffort?: ReasoningEffort
  signal?: AbortSignal
  flush?: () => Promise<void>
  /** Pure owner validation captured for this summary pass; never prepares/authenticates. */
  summaryInputGuard?: (inherited: boolean) => () => void
  /** Current system/tool overhead when the model-facing catalog is live. */
  overheadTokens?: () => number
  /** Optional full current input estimate, including system/tools. A host may
   * calibrate it with a completed provider report; rewritten projections fall
   * back to the existing meter. */
  contextTokens?: () => number
}): CompactionEngine {
  // M34 ⑦a: global chain + the per-model policy arm (deps.provider/modelId
  // select the exact "provider/model" entry of config.modelPolicies). No
  // provider/modelId → resolveConfig → pre-M34 behavior exactly.
  const config = resolveCompactSpec(deps.config, deps.provider, deps.modelId)
  function overheadNow(): number {
    const value = deps.overheadTokens?.() ?? config.overheadTokens
    if (!Number.isInteger(value) || value < 0) throw new Error("compaction overhead must be a non-negative integer")
    return value
  }
  // M15: catalog-first (profile.modelContexts[modelId] → profile.contextWindow
  // → config.contextWindow). No profile/modelId → config → M11/M14 behavior.
  const contextWindow = resolveContextWindow(deps.profile, deps.modelId, config)

  return createAdmission(
    config, contextWindow,
    session => deps.contextTokens?.() ?? activeTokens(session) + overheadNow(),
    overheadNow,
    (session, allowPruneOnly, instructions, options) => runCompactionPass(
      session, allowPruneOnly, instructions, options, config, contextWindow, deps, overheadNow,
    ),
    (session, retainLast) => resetWindowOnce(session, retainLast, deps.facts),
  )
}

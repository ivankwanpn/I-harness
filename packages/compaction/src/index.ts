import type { Session } from "@i-harness/core-session"
import { append, deriveSearchText } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import { resolveConfig, type CompactionConfig } from "./config.ts"
import { activeTokens } from "./tokens.ts"
import { selectShadowableRange } from "./region.ts"
import { summarizeWithModel } from "./summarizer.ts"

export { approxTokens, activeTokens, IMAGE_TOKEN_ESTIMATE } from "./tokens.ts"
export { selectShadowableRange } from "./region.ts"
export { resolveConfig } from "./config.ts"
export type { CompactionConfig, ResolvedCompactionConfig } from "./config.ts"

export interface CompactionResult {
  compacted: boolean
  shadowedSeqs: number[]
  summary?: string
}

export interface CompactionEngine {
  maybeCompact(session: Session): Promise<CompactionResult>
  compact(session: Session): Promise<CompactionResult>
}

export function createCompactionEngine(deps: { model: ModelClient; config: CompactionConfig }): CompactionEngine {
  const config = resolveConfig(deps.config)

  async function compactOnce(session: Session): Promise<CompactionResult> {
    const shadowedSeqs = selectShadowableRange(session, config.retainTokens)
    if (shadowedSeqs.length === 0) return { compacted: false, shadowedSeqs: [] }
    const replayText = renderShadowed(session, shadowedSeqs)
    const model = config.summarizationModel ?? deps.model
    let summary: string
    try {
      summary = await summarizeWithModel(model, replayText, config.maxTokens)
    } catch (err) {
      // Fail-soft: never block the agent on a summarizer failure. The warning
      // makes the otherwise-silent retry observable under sustained pressure.
      console.warn("[i-harness] compaction summarizer failed (fail-soft, retrying next step):", err instanceof Error ? err.message : String(err))
      return { compacted: false, shadowedSeqs: [] }
    }
    append(session, { type: "compaction/start" })
    append(session, { type: "compaction/summary", text: summary, shadowedSeqs })
    append(session, { type: "compaction/end" })
    return { compacted: true, shadowedSeqs, summary }
  }

  return {
    async maybeCompact(session: Session): Promise<CompactionResult> {
      if (activeTokens(session) < config.contextWindow * config.thresholdRatio) {
        return { compacted: false, shadowedSeqs: [] }
      }
      // Re-fire guard: with `retainTokens 0` and a large `maxTokens`, the
      // summary alone can re-cross the threshold, re-triggering the summarizer
      // (and re-rendering the whole non-marker log) at every step boundary.
      // Only re-compact once NEW non-marker events appear past the last
      // `compaction/end`. `compact()` (explicit) stays ungated.
      const last = lastCompactionEndSeq(session)
      if (last >= 0 && !hasNonMarkerEventsAfter(session, last)) {
        return { compacted: false, shadowedSeqs: [] } // no new work since the last compaction
      }
      return compactOnce(session)
    },
    compact: compactOnce,
  }
}

function lastCompactionEndSeq(session: Session): number {
  let last = -1
  for (const ev of session.events) {
    if (ev.type === "compaction/end" && ev.seq !== undefined) last = ev.seq
  }
  return last
}

function hasNonMarkerEventsAfter(session: Session, seq: number): boolean {
  for (const ev of session.events) {
    if (ev.seq === undefined || ev.seq <= seq) continue
    if (ev.type === "compaction/start" || ev.type === "compaction/end" || ev.type === "compaction/summary") continue
    return true
  }
  return false
}

function renderShadowed(session: Session, shadowedSeqs: number[]): string {
  const set = new Set(shadowedSeqs)
  const parts: string[] = []
  for (const ev of session.events) {
    if (ev.seq !== undefined && set.has(ev.seq)) {
      const t = deriveSearchText(ev)
      if (t.length > 0) parts.push(t)
    }
  }
  return parts.join("\n")
}

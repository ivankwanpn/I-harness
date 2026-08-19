import type { Session } from "@i-harness/core-session"
import { append, deriveSearchText } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import { resolveConfig, type CompactionConfig } from "./config.ts"
import { activeTokens } from "./tokens.ts"
import { selectShadowableRange } from "./region.ts"
import { summarizeWithModel } from "./summarizer.ts"

export { approxTokens, activeTokens } from "./tokens.ts"
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
    } catch {
      // Fail-soft: never block the agent on a summarizer failure.
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
      return compactOnce(session)
    },
    compact: compactOnce,
  }
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

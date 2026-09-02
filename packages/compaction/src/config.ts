import type { ModelClient } from "@i-harness/llm-seam"
import { resolveModelContext, type ProviderProfile } from "@i-harness/provider"

// M33 §3: model-free prune pass options. `false` (explicit) turns the whole
// pass off; the defaults are the recommended carving (aligned with the
// retention caps).
export interface PruneConfig {
  /** stringified tool/result output length beyond which it becomes a prune candidate. default 8192 */
  thresholdChars?: number
  /** leading chunk of the substitute. default 4096 */
  headChars?: number
  /** trailing chunk of the substitute. default 1024 */
  tailChars?: number
}

export interface CompactionConfig {
  contextWindow: number
  thresholdRatio?: number
  retainTokens?: number
  maxTokens?: number
  summarizationModel?: ModelClient
  auto?: boolean
  // M33 §3.1: host/assembly-known overhead the model surface does NOT carry
  // (system prompt + tool schemas) — added to the activeTokens measurement at
  // the pressure gate. 0 (default) = pre-M33 behavior.
  overheadTokens?: number
  // M33 §2.1: hysteresis — minimum turn/end events after the last compaction
  // before auto re-compaction is allowed. 0 = the pure pre-M33 re-fire guard.
  minTurnsBeforeRecompact?: number
  // M33 §4: model-free prune pass — default ON with this pass.
  // `false` disables it entirely (tests cover the off path).
  prune?: false | PruneConfig
}

export interface ResolvedPruneConfig {
  enabled: boolean
  thresholdChars: number
  headChars: number
  tailChars: number
}

export interface ResolvedCompactionConfig {
  contextWindow: number
  thresholdRatio: number
  retainTokens: number
  maxTokens: number
  summarizationModel?: ModelClient
  auto: boolean
  overheadTokens: number
  minTurnsBeforeRecompact: number
  prune: ResolvedPruneConfig
}

const PRUNE_DEFAULTS = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }

export function resolveConfig(config: CompactionConfig): ResolvedCompactionConfig {
  if (!Number.isInteger(config.contextWindow) || config.contextWindow <= 0) {
    throw new Error(`compaction: contextWindow must be a positive integer (got ${config.contextWindow})`)
  }
  const thresholdRatio = config.thresholdRatio ?? 0.8
  if (!(thresholdRatio > 0 && thresholdRatio <= 1)) {
    throw new Error(`compaction: thresholdRatio must be in (0, 1] (got ${thresholdRatio})`)
  }
  const retainTokens = config.retainTokens ?? 0
  if (!Number.isInteger(retainTokens) || retainTokens < 0) {
    throw new Error(`compaction: retainTokens must be a non-negative integer (got ${retainTokens})`)
  }
  const maxTokens = config.maxTokens ?? 1024
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`compaction: maxTokens must be a positive integer (got ${maxTokens})`)
  }
  const auto = config.auto ?? true
  const overheadTokens = config.overheadTokens ?? 0
  if (!Number.isInteger(overheadTokens) || overheadTokens < 0) {
    throw new Error(`compaction: overheadTokens must be a non-negative integer (got ${overheadTokens})`)
  }
  const minTurnsBeforeRecompact = config.minTurnsBeforeRecompact ?? 3
  if (!Number.isInteger(minTurnsBeforeRecompact) || minTurnsBeforeRecompact < 0) {
    throw new Error(`compaction: minTurnsBeforeRecompact must be a non-negative integer (got ${minTurnsBeforeRecompact})`)
  }
  const prune = resolvePrune(config.prune)
  return {
    contextWindow: config.contextWindow,
    thresholdRatio,
    retainTokens,
    maxTokens,
    auto,
    summarizationModel: config.summarizationModel,
    overheadTokens,
    minTurnsBeforeRecompact,
    prune,
  }
}

function resolvePrune(prune: CompactionConfig["prune"]): ResolvedPruneConfig {
  if (prune === false) return { enabled: false, ...PRUNE_DEFAULTS }
  const thresholdChars = prune?.thresholdChars ?? PRUNE_DEFAULTS.thresholdChars
  const headChars = prune?.headChars ?? PRUNE_DEFAULTS.headChars
  const tailChars = prune?.tailChars ?? PRUNE_DEFAULTS.tailChars
  for (const [name, value] of [["thresholdChars", thresholdChars], ["headChars", headChars], ["tailChars", tailChars]] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`compaction: prune.${name} must be a positive integer (got ${value})`)
    }
  }
  if (headChars + tailChars > thresholdChars) {
    throw new Error(`compaction: prune.headChars + tailChars (${headChars + tailChars}) must not exceed thresholdChars (${thresholdChars})`)
  }
  return { enabled: true, thresholdChars, headChars, tailChars }
}

// M15: catalog-first window resolution — per-model override → profile-level →
// config. Pure and exported so tests (and hosts) can assert it directly.
export function resolveContextWindow(
  profile: ProviderProfile | undefined,
  modelId: string | undefined,
  config: { contextWindow: number },
): number {
  const catalogWindow = profile && modelId
    ? resolveModelContext(profile, modelId).contextWindow
    : undefined
  return catalogWindow ?? config.contextWindow
}

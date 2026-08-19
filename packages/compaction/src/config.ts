import type { ModelClient } from "@i-harness/llm-seam"

export interface CompactionConfig {
  contextWindow: number
  thresholdRatio?: number
  retainTokens?: number
  maxTokens?: number
  summarizationModel?: ModelClient
  auto?: boolean
}

export interface ResolvedCompactionConfig {
  contextWindow: number
  thresholdRatio: number
  retainTokens: number
  maxTokens: number
  summarizationModel?: ModelClient
  auto: boolean
}

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
  return { contextWindow: config.contextWindow, thresholdRatio, retainTokens, maxTokens, auto, summarizationModel: config.summarizationModel }
}

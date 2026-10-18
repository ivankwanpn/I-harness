import type { ModelClient, ReasoningEffort, ModelBudgetBinding } from '@i-harness/llm-seam'
import type { ContextBindingMetadata } from '@i-harness/core-session'
import type { SummaryPort } from '@i-harness/context-engine'
import type { ResolvedCompactionConfig } from '../config.ts'
import type { Telemetry } from '@i-harness/telemetry'

/** Unbound factory: every owner supplies its own live selected client/surface. */
export interface SummaryFactoryInput {
  model: ModelClient
  config: ResolvedCompactionConfig
  contextMetadata?: ContextBindingMetadata
  budgetBinding?: ModelBudgetBinding
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  flush?: () => Promise<void>
  telemetry?: Telemetry
}
export type SummaryFactory = (input: SummaryFactoryInput) => SummaryPort

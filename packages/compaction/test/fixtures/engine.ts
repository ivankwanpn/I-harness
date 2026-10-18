import { createAgentContext } from '../../../core-agent/src/agent/context.ts'
import { createNondurableFactOwner, isNondurableSession, type FactOwner, type SessionView, type ManagedAction, type ProducerFactOutcome, type ContextBindingMetadata } from '@i-harness/core-session'
import { createSummaryPort } from '../../src/summary/port.ts'
import type { CompactionConfig, CompactionEngine, CompactionRunOptions } from '../../src/index.ts'
import type { ModelClient, ToolSchema, ReasoningEffort } from '@i-harness/llm-seam'
import type { Telemetry } from '@i-harness/telemetry'

/** Exercise the actual agent composition/bridge/engine with explicit fixture capabilities. */
export function createCompactionHarness(input: {
  model: ModelClient; config: CompactionConfig; factOwner?: FactOwner
  maxOutputTokens?: number; reasoningEffort?: ReasoningEffort; contextMetadata?: ContextBindingMetadata
  summaryMetadata?: ContextBindingMetadata; summaryReasoningEffort?: ReasoningEffort
  budgetBinding?: import('@i-harness/llm-seam').ModelBudgetBinding
  summaryBudgetBinding?: import('@i-harness/llm-seam').ModelBudgetBinding
  telemetry?: Telemetry; signal?: AbortSignal; flush?: () => Promise<void>
  requestShape?: () => { systemPrompt: string; tools: ToolSchema[] }
  provider?: string; modelId?: string
  facts?: () => import('../../../core-session/src/managed/ports.ts').LegacyCompactionFacts<ProducerFactOutcome>
  contextTokens?: () => number; overheadTokens?: () => number; summaryInputGuard?: (inherited: boolean) => () => void
}): CompactionEngine {
  async function execute(session: SessionView, method: 'compact' | 'maybeCompact' | 'recover' | 'resetWindow', instructions?: string, options?: CompactionRunOptions, retainLast?: number) {
    const owner = input.factOwner ?? (isNondurableSession(session) ? createNondurableFactOwner(session) : undefined)
    const action: ManagedAction<ProducerFactOutcome> | undefined = owner?.beginAction(options?.signal ?? input.signal)
    const config = { ...input.config, summaryMetadata: input.config.summaryMetadata ?? input.summaryMetadata, summaryReasoningEffort: input.config.summaryReasoningEffort ?? input.summaryReasoningEffort }
    const context = createAgentContext({ session, model: input.model, tools: { schemas: () => input.requestShape?.().tools ?? [] } as never,
      systemPrompt: () => input.requestShape?.().systemPrompt ?? '', compact: config, summaryFactory: createSummaryPort,
      contextMetadata: input.contextMetadata, budgetBinding: input.budgetBinding, maxOutputTokens: input.maxOutputTokens, reasoningEffort: input.reasoningEffort,
      telemetry: input.telemetry, flush: input.flush, signal: options?.signal ?? input.signal,
      captureContextReduction: action?.captureContextReduction?.bind(action), assertFactOpen: action?.assertOpen,
      facts: action?.facts, registerFactSource: action ? drain => action.registerSettlementSource(drain) : undefined,
    }, 'compaction-harness')
    try {
      if (method === 'compact') return await context.compactor!.compact(session, instructions, options)
      if (method === 'resetWindow') return await context.compactor!.resetWindow(session, retainLast!)
      return await context.compactor![method](session, options)
    } finally { action?.finish() }
  }
  return {
    compact: (session, instructions, options) => execute(session, 'compact', instructions, options),
    maybeCompact: (session, options) => execute(session, 'maybeCompact', undefined, options),
    recover: (session, options) => execute(session, 'recover', undefined, options),
    resetWindow: (session, retainLast) => execute(session, 'resetWindow', undefined, undefined, retainLast),
  }
}

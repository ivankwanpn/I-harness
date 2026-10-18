import { randomUUID } from 'node:crypto'
import { spawnChild, type SubagentRole } from '@i-harness/subagent'
import type { ApprovalGenerationAction, ModelClient } from '@i-harness/llm-seam'
import type { GuardianReviewDeps } from './reviewer.ts'

/** Existing reviewer role/model precedence, with a purpose-bound parent grant.
 * Resolving the final child binding updates only the selected-client witness. */
export function spawnReviewer(deps: GuardianReviewDeps, role: SubagentRole, message: string, signal: AbortSignal, generation: ApprovalGenerationAction | undefined, selected: (model: ModelClient) => void) {
  return spawnChild({
    taskName: `review-${randomUUID().slice(0, 8)}`, message, parentPath: 'root', parentRegistry: deps.parentRegistry,
    parentSession: deps.parentSession, parentCtx: deps.parentCtx, signal, sharedGeneration: generation,
    role: { ...role, ...(deps.policyText !== undefined ? { systemPrompt: deps.policyText } : {}), tools: [] },
    parentModel: deps.model ?? deps.parentModel,
    resolveModel: async selection => {
      const state = await deps.resolveModel(selection)
      if (state.status === 'ready') selected(state.binding.client)
      return state
    },
    ...(deps.roleSelectionFor !== undefined ? { roleSelectionFor: deps.roleSelectionFor } : {}),
    ...(deps.allowSubagentModelSelection !== undefined ? { allowSubagentModelSelection: deps.allowSubagentModelSelection } : {}),
    ...(deps.inheritedSystemContext ? { inheritedSystemContext: deps.inheritedSystemContext } : {}),
    ...(deps.autoCompactionEnabled ? { autoCompactionEnabled: deps.autoCompactionEnabled } : {}),
    summaryFactory: deps.summaryFactory,
    ...(deps.model === undefined && deps.contextWindow !== undefined ? { contextWindow: deps.contextWindow } : {}),
    ...(deps.model === undefined ? { budgetBinding: deps.budgetBinding, contextMetadata: deps.contextMetadata, reasoningEffort: deps.reasoningEffort, inheritedBindingForStep: deps.inheritedBindingForStep } : {}),
    ...(deps.model === undefined && deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
    jobs: deps.subagents.jobs, table: deps.subagents.table, agents: deps.subagents.agents, forkTurns: 'none',
    ...(deps.childSessions ? { childSessions: { ...deps.childSessions, origin: 'approval-review' } } : {}),
  })
}

import type {ResolvedCompactionConfig} from '@i-harness/compaction'
import type {ContextSnapshot} from '@i-harness/context-engine'
import type {ModelClient} from '@i-harness/llm-seam'
import {projectionFingerprint} from '@i-harness/token-meter'
/** Stable selected summary facts, shared by soft keys and held-source fences.
 * Never hashes a client object, global revision or process-local identity. */
export function summaryPolicyIdentity(config:ResolvedCompactionConfig,surface:ContextSnapshot['surface'],main:ModelClient):string {
 const inherited=!config.summarizationModel||config.summarizationModel===main
 const binding=inherited?surface.budgetBinding:config.summaryBudgetBinding
 const metadata=inherited?surface.binding??binding?.metadata:config.summaryMetadata??binding?.metadata
 return projectionFingerprint({selection:inherited?'inherited':'selected',binding,metadata,
  contextWindow:inherited?metadata?.contextWindow??binding?.limits.contextTokens?.value??config.contextWindow:config.summaryLimits?.contextWindow??metadata?.contextWindow??binding?.limits.contextTokens?.value,
  outputCeiling:inherited?binding?.limits.outputTokens?.value:config.summaryLimits?.maxOutputTokens??binding?.limits.outputTokens?.value,
  reasoningEffort:inherited?surface.reasoningEffort:config.summaryReasoningEffort,
  outputPreference:config.summaryMaxOutputTokens,explicitOutput:config.summaryOutputCapExplicit,retainedTokens:config.maxTokens,minimumChars:config.minSummaryChars})
}

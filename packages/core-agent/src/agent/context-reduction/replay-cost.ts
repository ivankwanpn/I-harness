import type { ContextSnapshot } from '@i-harness/context-engine'
import type { ProjectedInputFacts } from '@i-harness/token-meter'

/** Price the exact original route. Re-preparing a shortened prefix could
 * invalidate another exchange's signed reasoning and misattribute its cost. */
export function retainedReplayCosts(conversation: ContextSnapshot['conversation'], input: ProjectedInputFacts): ReadonlyMap<string, number> | undefined {
  const total = input.components.replayedReasoning.heuristicTokens
  if (!Number.isSafeInteger(total) || total <= 0 || input.coverage !== 'complete' || input.overriddenInputFields.includes('messages')) return

  // renderConversation emits current messages first, followed by each item's
  // messages. Current/system-owned reasoning has no reducible item ID.
  const owners: (string | undefined)[] = []
  for (const message of conversation.current?.messages ?? []) if (message.role === 'assistant') owners.push(undefined)
  for (const item of conversation.items) {
    for (const message of item.messages) if (message.role === 'assistant') owners.push(item.id)
  }

  const costs = new Map<string, number>()
  let attributed = 0
  for (const { role, sourceAssistantOrdinal, replayedReasoningTokens } of input.units) {
    if (replayedReasoningTokens === undefined) continue
    if (role !== 'assistant' || !Number.isSafeInteger(replayedReasoningTokens) || replayedReasoningTokens <= 0 ||
        sourceAssistantOrdinal === undefined || !Number.isSafeInteger(sourceAssistantOrdinal) ||
        sourceAssistantOrdinal < 0 || sourceAssistantOrdinal >= owners.length) return
    attributed += replayedReasoningTokens
    const owner = owners[sourceAssistantOrdinal]
    if (owner !== undefined) costs.set(owner, (costs.get(owner) ?? 0) + replayedReasoningTokens)
  }
  // Custom or older adapters may measure a total without assigning every
  // unit. In that case keep the neutral retention policy.
  return attributed === total ? costs : undefined
}

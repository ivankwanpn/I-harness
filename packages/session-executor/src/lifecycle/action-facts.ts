import type { AgentFacts, FactOwner, MetadataFacts, ProducerFactOutcome } from '@i-harness/core-session'

/** One-shot host ports release their action as soon as the receipt returns.
 * Long-running Agent/tool sources keep their separate registered lifecycle. */
export function actionMetadataFacts(owner: FactOwner, signal?: AbortSignal): MetadataFacts<ProducerFactOutcome> {
  const run = async (invoke: (facts: MetadataFacts<ProducerFactOutcome>) => Promise<ProducerFactOutcome>) => {
    const action = owner.beginAction(signal)
    try { return await invoke(action.facts.metadata) } finally { action.finish() }
  }
  return { admit: event => run(facts => facts.admit(event)), enterPlan: proposal => run(facts => facts.enterPlan(proposal)), importPolicy: modes => run(facts => facts.importPolicy(modes)) }
}
export function actionFeedbackFacts(owner: FactOwner, signal?: AbortSignal): Pick<AgentFacts<ProducerFactOutcome>, 'feedback'> {
  return { async feedback(event) {
    const action = owner.beginAction(signal)
    try { return await action.facts.agent.feedback(event) } finally { action.finish() }
  } }
}

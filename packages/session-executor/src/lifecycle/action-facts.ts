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
type FeedbackPort = Pick<AgentFacts<ProducerFactOutcome>, 'feedback'>
const feedbackSources = new WeakMap<FactOwner, { signals: WeakMap<AbortSignal, FeedbackPort>; unscoped?: FeedbackPort }>()

/** Identity belongs to this actual document/source and original signal. Merely
 * resolving the composition factory creates no action or later-turn authority. */
export function actionFeedbackFacts(owner: FactOwner, signal?: AbortSignal): FeedbackPort {
  let source = feedbackSources.get(owner)
  if (!source) { source = { signals: new WeakMap() }; feedbackSources.set(owner, source) }
  const existing = signal ? source.signals.get(signal) : source.unscoped
  if (existing) return existing
  const port: FeedbackPort = { async feedback(event) {
    const action = owner.beginAction(signal)
    try { return await action.facts.agent.feedback(event) } finally { action.finish() }
  } }
  if (signal) source.signals.set(signal, port)
  else source.unscoped = port
  return port
}

import type { AgentFacts, FactOwner, MetadataFacts, ProducerFactOutcome } from '@i-harness/core-session'
type ActionOwner = Pick<FactOwner,'beginAction'>

/** One actual source identity per owner/signal while captures are outstanding.
 * The last terminal capture releases the action; unknown captures keep it. */
export function createRuntimeContextSource(owner: ActionOwner): import('@i-harness/core-session').RuntimeContextFactSource {
  type Source = ReturnType<import('@i-harness/core-session').RuntimeContextFactSource>
  const scoped = new WeakMap<AbortSignal, Source>()
  let unscoped: Source | undefined
  return signal => {
    const existing = signal ? scoped.get(signal) : unscoped
    if (existing) return existing
    const action = owner.beginAction(signal)
    let captures = 0
    const source: Source = {
      captureRuntimeContext(record, checkCurrent) { const capture = action.captureRuntimeContext(record, checkCurrent); captures++; return capture },
      finish() {
        if (--captures > 0) return
        if (signal) scoped.delete(signal); else unscoped = undefined
        action.finish()
      },
    }
    if (signal) scoped.set(signal, source); else unscoped = source
    return source
  }
}

/** One-shot host ports release their action as soon as the receipt returns.
 * Long-running Agent/tool sources keep their separate registered lifecycle. */
export function actionMetadataFacts(owner: ActionOwner, signal?: AbortSignal): MetadataFacts<ProducerFactOutcome> {
  const run = async (invoke: (facts: MetadataFacts<ProducerFactOutcome>) => Promise<ProducerFactOutcome>) => {
    const action = owner.beginAction(signal)
    try { return await invoke(action.facts.metadata) } finally { action.finish() }
  }
  return { admit: event => run(facts => facts.admit(event)), enterPlan: proposal => run(facts => facts.enterPlan(proposal)), importPolicy: modes => run(facts => facts.importPolicy(modes)) }
}
type FeedbackPort = Pick<AgentFacts<ProducerFactOutcome>, 'feedback'>
const feedbackSources = new WeakMap<ActionOwner, { signals: WeakMap<AbortSignal, FeedbackPort>; unscoped?: FeedbackPort }>()

/** Identity belongs to this actual document/source and original signal. Merely
 * resolving the composition factory creates no action or later-turn authority. */
export function actionFeedbackFacts(owner: ActionOwner, signal?: AbortSignal): FeedbackPort {
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

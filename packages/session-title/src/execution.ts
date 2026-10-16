import { createNondurableFactOwner, isNondurableSession, type ManagedAction, type ProducerFactOutcome, type SessionView } from '@i-harness/core-session'

/** Host composition passes only the original title action's narrow surface.
 * The creator retains finish; no model/tool receives this capability. */
export type TitleAction = Pick<ManagedAction<ProducerFactOutcome>, 'signal' | 'assertOpen'> & {
  readonly view: SessionView
  readonly facts: Pick<ManagedAction<ProducerFactOutcome>['facts'], 'metadata'>
}

export function resolveTitleAction(view: SessionView, supplied?: TitleAction, signal?: AbortSignal): { context: TitleAction; finish(): void } {
  if (supplied) {
    if (supplied.view !== view) throw Object.assign(new Error('Title action requires its original Session view'), { code: 'FACT_OWNER_UNSUPPORTED' })
    supplied.assertOpen()
    return { context: supplied, finish() {} }
  }
  if (!isNondurableSession(view)) throw Object.assign(new Error('Managed title inference requires its original action'), { code: 'FACT_OWNER_UNSUPPORTED' })
  const action = createNondurableFactOwner(view).beginAction(signal)
  action.assertOpen()
  return { context: { view, signal: action.signal, assertOpen: action.assertOpen, facts: { metadata: action.facts.metadata } }, finish: action.finish }
}

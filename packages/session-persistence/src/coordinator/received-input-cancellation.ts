import { isManagedFactOwner, isStrictFactData, readInbox, type SessionView } from '@i-harness/core-session'
import type { InvalidNotIssued } from './settlement-fact.ts'

/** A new held cancellation may target an own cold-loaded admission. Historical
 * observations and absence alone never retire an original required capture. */
export function cancellationRetirementFor(view: SessionView, owner: object) {
  return (value: unknown): ((outcome: InvalidNotIssued) => boolean) | undefined => {
    if (!isManagedFactOwner(view, owner) || !isStrictFactData(value) || !value || typeof value !== 'object' || Array.isArray(value)) return
    const event = value as { type?: unknown; version?: unknown; inputId?: unknown; reason?: unknown }
    const fields = Object.getOwnPropertyDescriptors(event)
    if (!fields.type || !fields.version || !fields.inputId || Object.keys(fields).some(key => !['type', 'version', 'inputId', 'reason'].includes(key) || !fields[key]!.enumerable) || event.type !== 'agent/input/cancelled' || event.version !== 1
      || typeof event.inputId !== 'string' || !event.inputId || event.reason !== undefined && typeof event.reason !== 'string') return
    const inputId = event.inputId
    const admission = view.events.findLast(event => event.type === 'agent/input/admitted' && event.inputId === inputId)
    if (admission?.type !== 'agent/input/admitted' || admission.seq === undefined || admission.seq < (view.header?.seedLength ?? 0)
      || admission.provenance?.kind === 'inherited' || !readInbox(view).isPending(inputId)) return
    const admissionSeq = admission.seq
    return outcome => {
      if (outcome.kind !== 'not-issued' || outcome.code !== 'FACT_INVALID_GROUP' || !isManagedFactOwner(view, owner) || view.events[admissionSeq] !== admission
        || view.events.findLast(event => event.type === 'agent/input/admitted' && event.inputId === inputId) !== admission || readInbox(view).isPending(inputId)) return false
      return view.events.some(event => event.seq !== undefined && event.seq > admissionSeq && (event.type === 'agent/input/promoted' || event.type === 'agent/input/cancelled') && event.inputId === inputId)
    }
  }
}
